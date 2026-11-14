import { validTarget, type FileTarget } from "../shared/wire";
import {
  RECEIPT_TTL_MS, laterStage, terminalOutcome, type FileOpenOutcome, type FileOpenReceipt,
  type FileOpenReason, type FileOpenStage,
} from "../shared/receipts";
import type { FileOpenSignal } from "./host-capabilities";

export interface EditorConnection { codiumBaseUrl: string; openMode: "external" | "embedded" }
export function editorConnectionKey(connection: EditorConnection): string {
  return JSON.stringify([connection.codiumBaseUrl, connection.openMode]);
}

/** Old, unqualified targets must not be restored into a different Codium instance. */
export function restoredEditorTarget(state: unknown, connectionKey: string): FileTarget | undefined {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const saved = state as { connectionKey?: unknown; lastTarget?: unknown };
  return saved.connectionKey === connectionKey && validTarget(saved.lastTarget) ? saved.lastTarget : undefined;
}

interface FileNavigationStamp {
  documentEpoch: number;
  revision: number;
  targetKey: string;
  outcome: "attempted" | "queued" | "skipped" | "failed";
}
interface FileNavigationInput {
  documentEpoch: number;
  revision: number;
  targetKey: string;
  visible: boolean;
  enabled: boolean;
  state: unknown;
  writeState(state: Record<string, unknown>): void;
  open(): void;
}
const navigationClaims = new WeakMap<FileNavigationInput["writeState"], string>();

/** Host revision increments for a file-open intent, but stays unchanged on remount. */
export function forwardFileNavigation(input: FileNavigationInput): "unchanged" | "queued" | "skipped" | "failed" {
  if (!Number.isFinite(input.documentEpoch) || input.documentEpoch <= 0 ||
      !Number.isSafeInteger(input.revision) || input.revision <= 0 || (input.enabled && !input.visible)) return "unchanged";
  const state = typeof input.state === "object" && input.state !== null && !Array.isArray(input.state)
    ? input.state as Record<string, unknown>
    : input.state === undefined ? {} : { previousPanelState: input.state };
  const stamp: FileNavigationStamp = {
    documentEpoch: input.documentEpoch, revision: input.revision, targetKey: input.targetKey, outcome: "attempted",
  };
  const key = JSON.stringify([stamp.documentEpoch, stamp.revision, stamp.targetKey]);
  const previous = state.codiumFileNavigation as Partial<FileNavigationStamp> | undefined;
  if (navigationClaims.get(input.writeState) === key || (previous?.documentEpoch === stamp.documentEpoch &&
      previous.revision === stamp.revision && previous.targetKey === stamp.targetKey)) return "unchanged";
  // Claim before dispatch: StrictMode, settings writes and synchronous host renders
  // cannot enqueue twice. Persist the attempt so plugin reload also cannot replay it.
  navigationClaims.set(input.writeState, key);
  try {
    input.writeState({ ...state, codiumFileNavigation: stamp });
    if (input.enabled) input.open();
    const outcome = input.enabled ? "queued" : "skipped";
    input.writeState({ ...state, codiumFileNavigation: { ...stamp, outcome } });
    return outcome;
  } catch {
    try { input.writeState({ ...state, codiumFileNavigation: { ...stamp, outcome: "failed" } }); } catch { /* Memory claim still prevents a retry loop. */ }
    return "failed";
  }
}

export function shouldProtectEditor(state: { dirty: boolean; known: boolean; connected?: boolean }, frameFocused: boolean, observedEpoch: number, currentEpoch: number, freshCloseSupported = false): boolean {
  return state.dirty || !state.known || state.connected === false || (!freshCloseSupported && (frameFocused || observedEpoch !== currentEpoch));
}

/** A close decision must use a new paired-window snapshot, never the last poll. */
export async function resolveEditorCloseProtection<State extends { dirty: boolean; known: boolean; connected: boolean }>(
  read: () => Promise<State>, isCurrent: () => boolean, publish: (state: State) => boolean,
): Promise<boolean> {
  const state = await read();
  if (!isCurrent()) return true;
  return publish(state) || !state.connected || !state.known || state.dirty;
}

const MAX_CLIENT_RECEIPTS = 128;
export class EditorReceipts {
  private readonly receipts = new Map<string, FileOpenReceipt>();
  constructor(private readonly now: () => number = Date.now) {}
  begin(requestId: string, stage: FileOpenStage = "host_route"): FileOpenReceipt {
    // Expired terminal memory is UNKNOWN, not a retained duplicate.
    this.prune();
    const existing = this.receipts.get(requestId);
    if (existing) return { ...existing };
    const at = this.now();
    if (this.receipts.size >= MAX_CLIENT_RECEIPTS && !this.evictOne()) {
      // Explicit admission failure, never a silently untracked pending receipt.
      return {
        version: 2, correlationId: requestId, requestId, stage, outcome: "not_sent", dispatched: false,
        reason: "capacity", updatedAt: at, expiresAt: at + RECEIPT_TTL_MS,
      };
    }
    const receipt: FileOpenReceipt = {
      version: 2, correlationId: requestId, requestId, stage, outcome: "pending", dispatched: false,
      updatedAt: at, expiresAt: at + RECEIPT_TTL_MS,
    };
    this.receipts.set(requestId, receipt);
    return { ...receipt };
  }
  /**
   * A known-unsent identity may be retried under the same original identity.
   * Unknown/opened/failed outcomes never reset; those require a new intent.
   */
  retry(requestId: string, stage: FileOpenStage = "host_route"): FileOpenReceipt {
    this.prune();
    const existing = this.receipts.get(requestId);
    if (!existing) return this.begin(requestId, stage);
    if (existing.outcome !== "not_sent") return { ...existing };
    const at = this.now();
    const receipt: FileOpenReceipt = {
      ...existing, stage, outcome: "pending", dispatched: false, updatedAt: at, expiresAt: at + RECEIPT_TTL_MS,
    };
    delete receipt.reason;
    this.receipts.set(requestId, receipt);
    return { ...receipt };
  }
  advance(requestId: string, stage: FileOpenStage, outcome: FileOpenOutcome = "pending", reason?: FileOpenReason): FileOpenReceipt {
    let receipt = this.receipts.get(requestId);
    if (!receipt) {
      receipt = this.begin(requestId);
      if (!this.receipts.has(requestId)) return receipt;
    }
    if (!terminalOutcome(receipt.outcome)) {
      const at = this.now();
      receipt = {
        ...receipt, stage: laterStage(receipt.stage, stage), outcome,
        dispatched: receipt.dispatched || outcome === "sent" || outcome === "uncertain" || outcome === "opened" || outcome === "failed",
        ...(reason && terminalOutcome(outcome) ? { reason } : {}),
        updatedAt: at, expiresAt: at + RECEIPT_TTL_MS,
      };
      if (!reason) delete receipt.reason;
      this.receipts.set(requestId, receipt);
    }
    return { ...receipt };
  }
  /** A null/expired server receipt is UNKNOWN; it never becomes not_sent. */
  merge(requestId: string, server: FileOpenReceipt | null | undefined): FileOpenReceipt | undefined {
    this.prune();
    if (!server) return this.get(requestId);
    const existing = this.receipts.get(requestId);
    // Authoritative opened/failed evidence is never weakened by an uncertain or
    // earlier diagnostic update. A null/expired server receipt stays UNKNOWN.
    if (existing && (existing.outcome === "opened" || existing.outcome === "failed") &&
        server.outcome !== "opened" && server.outcome !== "failed") return { ...existing };
    const merged: FileOpenReceipt = {
      ...server,
      correlationId: requestId,
      requestId,
      stage: existing ? laterStage(existing.stage, server.stage) : server.stage,
    };
    if (!existing && this.receipts.size >= MAX_CLIENT_RECEIPTS && !this.evictOne()) return merged;
    this.receipts.set(requestId, merged);
    while (this.receipts.size > MAX_CLIENT_RECEIPTS && this.evictOne()) { /* bounded */ }
    this.prune();
    return { ...merged };
  }
  get(requestId: string): FileOpenReceipt | undefined {
    this.prune();
    const receipt = this.receipts.get(requestId);
    return receipt ? { ...receipt } : undefined;
  }
  prune() {
    for (const [requestId, receipt] of this.receipts) {
      if (terminalOutcome(receipt.outcome) && this.now() >= receipt.expiresAt) this.receipts.delete(requestId);
    }
  }
  clear() { this.receipts.clear(); }
  private evictOne(): boolean {
    // Never evict a non-expired uncertain outcome. Expired entries are removed by
    // prune; if only uncertain receipts remain, admission fails explicitly.
    const entries = [...this.receipts.entries()].filter(([, receipt]) =>
      terminalOutcome(receipt.outcome) && receipt.outcome !== "uncertain");
    if (!entries.length) return false;
    entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    this.receipts.delete(entries[0]![0]);
    return true;
  }
}
export const editorReceipts = new EditorReceipts();
export function clearEditorReceipts() { editorReceipts.clear(); }

export interface ActiveFileObservation {
  changed: boolean;
  activeFile?: string | null;
  /** Present only for a newly observed revealable file. */
  reveal?: string;
}
/**
 * Tracks observed active files and prevents a stale cached state from overriding
 * the just-confirmed open target. Omitted means no observation; null clears.
 */
export class ActiveFileTracker {
  private observed?: string | null;
  private barrier?: number;
  private generation = 0;
  private pendingFresh = false;
  private resyncNeeded = false;
  get epoch(): number { return this.generation; }
  get awaitingFresh(): boolean { return this.pendingFresh; }
  get needsResync(): boolean { return this.resyncNeeded && !this.pendingFresh; }
  confirm(activeFile: string, sequence: number) {
    this.observed = activeFile;
    this.barrier = sequence;
    // Invalidates an in-flight cached poll that started before this ACK.
    this.pendingFresh = false;
    this.resyncNeeded = false;
    this.generation += 1;
  }
  /**
   * After a confirmed open ACK the server cache may already be ahead with an old
   * active file while the companion's new state is still coalesced. Suspend poll
   * active-file application until a fresh companion snapshot supplies a real
   * sequence boundary (or the request fails).
   */
  beginFresh(): number {
    this.pendingFresh = true;
    this.generation += 1;
    return this.generation;
  }
  resolveFresh(activeFile: string | null | undefined, sequence: number, token: number): ActiveFileObservation | undefined {
    if (token !== this.generation) return undefined;
    this.pendingFresh = false;
    this.resyncNeeded = false;
    // A successful fresh snapshot is the new real boundary; it must replace the
    // conservative MAX barrier installed by failFresh.
    this.barrier = sequence;
    if (activeFile === undefined) return { changed: false };
    const changed = this.observed !== activeFile;
    this.observed = activeFile;
    return {
      changed,
      activeFile,
      ...(changed && typeof activeFile === "string" ? { reveal: activeFile } : {}),
    };
  }
  failFresh(token: number) {
    if (token !== this.generation) return;
    this.pendingFresh = false;
    // No real boundary was established. Keep the confirmed target and never let
    // an older cached poll replace it. A later normal poll/refresh retries once.
    this.resyncNeeded = true;
    this.barrier = Number.MAX_SAFE_INTEGER;
  }
  observe(activeFile: string | null | undefined, sequence: number, epoch = this.generation): ActiveFileObservation {
    if (epoch !== this.generation || this.pendingFresh || activeFile === undefined) return { changed: false };
    if (this.barrier !== undefined && sequence <= this.barrier) return { changed: false, activeFile };
    if (this.observed === activeFile) return { changed: false, activeFile };
    this.observed = activeFile;
    return {
      changed: true,
      activeFile,
      ...(typeof activeFile === "string" ? { reveal: activeFile } : {}),
    };
  }
  get current(): string | null | undefined { return this.observed; }
  reset() {
    this.observed = undefined; this.barrier = undefined; this.pendingFresh = false;
    this.resyncNeeded = false; this.generation += 1;
  }
}

export interface ReceiptInspectionToken { requestId: string; generation: number }
/**
 * Guards the async Check-outcome path. Showing a new request, clearing, or
 * starting another check invalidates older queries so a slow receipt(A) cannot
 * overwrite request B's displayed receipt, error or note.
 */
export class ReceiptInspection {
  private requestId?: string;
  private generation = 0;
  show(requestId: string) { this.requestId = requestId; this.generation += 1; }
  clear() { this.requestId = undefined; this.generation += 1; }
  begin(): ReceiptInspectionToken | undefined {
    if (!this.requestId) return undefined;
    this.generation += 1;
    return { requestId: this.requestId, generation: this.generation };
  }
  accepts(token: ReceiptInspectionToken): boolean {
    return this.requestId === token.requestId && this.generation === token.generation;
  }
}

/** Host tab visibility alone is insufficient when the browser/document is hidden. */
export function editorPanelVisible(hostVisible: boolean | undefined, observedVisible: boolean, documentVisible: boolean): boolean {
  return (hostVisible ?? observedVisible) && documentVisible;
}

/** A created session is stale if its attempt was superseded, disposed or replaced. */
export function shouldReleaseCreatedSession(input: {
  disposed: boolean; attempt: number; currentAttempt: number; hasSession: boolean;
}): boolean {
  return input.disposed || input.attempt !== input.currentAttempt || input.hasSession;
}

export function relativeWorkspacePath(directory: string, path: string): string {
  const prefix = directory.replace(/\/+$/, "") + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Post-ACK editor navigation reveal is a fresh panel-scoped auto reveal. It must
 * not present the already-settled host route request id as a live request; the
 * original correlation id stays in receipts. A disposed panel reveals nothing.
 */
export function revealOpenedFile(input: {
  reveal?: (path: string) => void; directory: string; path: string; isCurrent?: () => boolean;
}): boolean {
  if (!input.reveal || (input.isCurrent && !input.isCurrent())) return false;
  input.reveal(relativeWorkspacePath(input.directory, input.path));
  return true;
}

/** Display-only poll cadence; heartbeat and close snapshots are independent. */
export const EDITOR_POLL_VISIBLE_MS = 2_000;
export const EDITOR_POLL_HIDDEN_MS = 15_000;
export function editorPollDelay(visible: boolean): number {
  return visible ? EDITOR_POLL_VISIBLE_MS : EDITOR_POLL_HIDDEN_MS;
}

export interface FileRequest { requestId: string; connectionKey: string; target: FileTarget; signal?: FileOpenSignal }
interface PendingFileRequest extends FileRequest { expiresAt: number }
export const PENDING_FILE_TTL_MS = 5 * 60_000;
const MAX_WORKSPACE_QUEUES = 128;
/** Registry lives in this client runtime, never in shared host settings. */
export class EditorQueue {
  private requests: PendingFileRequest[] = [];
  private listeners = new Set<() => void>();
  private lastOpened?: { connectionKey: string; target: FileTarget };
  private expired = false;
  private lastActivity: number;
  constructor(private readonly now: () => number = Date.now) { this.lastActivity = now(); }
  touch() { this.lastActivity = this.now(); }
  private pruneExpired() {
    for (const request of this.requests) {
      if (!request.signal?.aborted) continue;
      // Once the request crossed the RPC boundary, cancellation is never
      // authoritative non-admission. Only an unsent queued intent is not_sent.
      if (editorReceipts.get(request.requestId)?.dispatched) {
        editorReceipts.advance(request.requestId, "execution", "uncertain", "cancelled");
      } else {
        editorReceipts.advance(request.requestId, "queue", "not_sent", "cancelled");
      }
    }
    this.requests = this.requests.filter((request) => !request.signal?.aborted);
    const before = this.requests.length;
    for (const request of this.requests) {
      if (request.expiresAt > this.now()) continue;
      if (editorReceipts.get(request.requestId)?.dispatched) {
        editorReceipts.advance(request.requestId, "execution", "uncertain", "timeout");
      } else {
        editorReceipts.advance(request.requestId, "queue", "not_sent", "queue_expired");
      }
    }
    this.requests = this.requests.filter((request) => request.expiresAt > this.now());
    if (this.requests.length < before) this.expired = true;
  }
  takeExpiredNotice(): boolean {
    this.pruneExpired();
    const expired = this.expired; this.expired = false;
    return expired;
  }
  isIdleExpired(): boolean { return this.listeners.size === 0 && this.now() - this.lastActivity >= PENDING_FILE_TTL_MS; }
  canEvict(): boolean { return this.listeners.size === 0 && !this.peek(); }
  lastTargetFor(connectionKey: string): FileTarget | undefined {
    return this.lastOpened?.connectionKey === connectionKey ? this.lastOpened.target : undefined;
  }
  discardOtherConnections(connectionKey: string) {
    this.pruneExpired();
    for (const request of this.requests) {
      if (request.connectionKey === connectionKey) continue;
      if (editorReceipts.get(request.requestId)?.dispatched) {
        editorReceipts.advance(request.requestId, "execution", "uncertain", "connection_changed");
      } else {
        editorReceipts.advance(request.requestId, "queue", "not_sent", "connection_changed");
      }
    }
    this.requests = this.requests.filter((entry) => entry.connectionKey === connectionKey);
  }
  private checkCapacity(connectionKey: string) {
    this.pruneExpired();
    if (this.requests.filter((entry) => entry.connectionKey === connectionKey).length >= 32) {
      throw new Error("Too many queued files. Wait for the editor to connect.");
    }
  }
  enqueue(request: FileRequest) {
    this.pruneExpired();
    const existing = this.requests.find((entry) => entry.requestId === request.requestId);
    if (existing) {
      if (existing.connectionKey !== request.connectionKey || JSON.stringify(existing.target) !== JSON.stringify(request.target)) {
        throw new Error("Request identifier was reused for a different file or connection.");
      }
      return;
    }
    this.checkCapacity(request.connectionKey);
    let receipt = editorReceipts.begin(request.requestId);
    if (receipt.outcome === "not_sent" && receipt.reason !== "capacity") {
      receipt = editorReceipts.retry(request.requestId);
    }
    if (receipt.outcome === "not_sent") {
      throw new Error(receipt.reason === "capacity"
        ? "Too many tracked file requests. Wait for pending files to expire."
        : "This file request was already closed. Open the file again.");
    }
    if (receipt.outcome === "opened" || receipt.outcome === "failed" || receipt.outcome === "uncertain") {
      throw new Error("Request identifier was already completed. Open the file again with a new request.");
    }
    this.discardOtherConnections(request.connectionKey);
    this.requests.push({ ...request, expiresAt: this.now() + PENDING_FILE_TTL_MS });
    editorReceipts.advance(request.requestId, "queue", "queued");
    this.touch();
    for (const listener of this.listeners) listener();
  }
  route(request: FileRequest, openPanel: () => void) {
    this.checkCapacity(request.connectionKey);
    // A connected editor drains synchronously on enqueue notification. Route
    // first so a failing host focus operation cannot send a file command.
    openPanel();
    this.enqueue(request);
  }
  advancePending(connectionKey: string, stage: FileOpenStage) {
    for (const request of this.requests) {
      if (request.connectionKey === connectionKey) editorReceipts.advance(request.requestId, stage);
    }
  }
  peek() { this.pruneExpired(); return this.requests[0]; }
  peekForConnection(connectionKey: string) {
    const request = this.peek();
    return request?.connectionKey === connectionKey ? request : undefined;
  }
  complete(requestId: string, connectionKey: string, outcome: "opened" | "failed" | "not_sent" | "uncertain" | boolean) {
    this.pruneExpired();
    const first = this.requests[0];
    if (first?.requestId !== requestId || first.connectionKey !== connectionKey) return;
    this.requests.shift();
    const normalized = outcome === true ? "opened" : outcome === false ? "failed" : outcome;
    if (normalized === "opened") {
      this.lastOpened = { connectionKey, target: first.target };
      editorReceipts.advance(requestId, "ack", "opened");
    } else if (normalized === "uncertain") {
      editorReceipts.advance(requestId, "execution", "uncertain", "disconnected");
    } else if (normalized === "not_sent") {
      editorReceipts.advance(requestId, "queue", "not_sent", "bridge_unavailable");
    } else {
      editorReceipts.advance(requestId, "ack", "failed");
    }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener); this.touch();
    return () => { this.listeners.delete(listener); this.touch(); };
  }
}
const queues = new Map<string, EditorQueue>();
export function editorQueue(hostId: string, workspaceId: string): EditorQueue {
  for (const [key, queue] of queues) if (queue.isIdleExpired()) queues.delete(key);
  const key = JSON.stringify([hostId, workspaceId]);
  let queue = queues.get(key);
  if (!queue) {
    if (queues.size >= MAX_WORKSPACE_QUEUES) {
      const disposable = [...queues].find(([, candidate]) => candidate.canEvict());
      if (disposable) queues.delete(disposable[0]);
      else throw new Error("Too many workspace editors. Close unused editors or wait for pending files to expire.");
    }
    queue = new EditorQueue(); queues.set(key, queue);
  }
  queue.touch();
  return queue;
}
export function clearEditorQueues() { queues.clear(); clearEditorReceipts(); }
