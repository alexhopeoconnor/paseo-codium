import { validTarget, type FileTarget } from "../shared/wire";

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

export function shouldProtectEditor(state: { dirty: boolean; known: boolean }, frameFocused: boolean, observedEpoch: number, currentEpoch: number): boolean {
  return state.dirty || !state.known || frameFocused || observedEpoch !== currentEpoch;
}

export interface FileRequest { requestId: string; connectionKey: string; target: FileTarget }
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
    const before = this.requests.length;
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
    if (this.requests.some((entry) => entry.requestId === request.requestId && entry.connectionKey === request.connectionKey)) return;
    this.checkCapacity(request.connectionKey);
    this.discardOtherConnections(request.connectionKey);
    this.requests.push({ ...request, expiresAt: this.now() + PENDING_FILE_TTL_MS });
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
  peek() { this.pruneExpired(); return this.requests[0]; }
  peekForConnection(connectionKey: string) {
    const request = this.peek();
    return request?.connectionKey === connectionKey ? request : undefined;
  }
  complete(requestId: string, connectionKey: string, opened: boolean) {
    this.pruneExpired();
    const first = this.requests[0];
    if (first?.requestId !== requestId || first.connectionKey !== connectionKey) return;
    this.requests.shift();
    if (opened) this.lastOpened = { connectionKey, target: first.target };
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
export function clearEditorQueues() { queues.clear(); }
