import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Socket } from "node:net";
import type { FileTarget } from "../shared/wire";
import type { SessionState, PresentationSettings } from "../shared/rpc";
import {
  MAX_RECEIPTS, RECEIPT_TTL_MS, terminalOutcome, type FileOpenReceipt, type FileOpenReason,
  type FileOpenStage,
} from "../shared/receipts";

export const BOOTSTRAP_TTL_MS = 120_000;
const LEASE_MS = 30 * 60_000;
const RESPONSE_MS = 15_000;
const MAX_PENDING_REQUESTS = 16;
interface RequestEntry {
  fingerprint: string;
  receipt: FileOpenReceipt;
  promise: Promise<FileOpenReceipt>;
  resolve(receipt: FileOpenReceipt): void;
  timer?: ReturnType<typeof setTimeout>;
}
export interface Session {
  id: string; ownerKey: string; bootstrapKey: string; workspaceId: string; directory: string;
  clientId: string; presentation: PresentationSettings; created: number; touched: number;
  bound?: { windowId: string; connectionId: string };
  socket?: Socket; lastSeen: number; dirty: boolean; known: boolean; sequence: number;
  activeFile?: string | null;
  snapshots: Map<string, { resolve(state: SessionState): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
  requests: Map<string, RequestEntry>;
}
export class EditorSessions {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly now: () => number = Date.now) {}
  create(workspaceId: string, clientId: string, directory: string, presentation: PresentationSettings = { closePrimarySidebar: false }) {
    this.prune();
    if (this.sessions.size >= 64) throw new Error("Too many editor sessions. Close unused Codium panels and retry.");
    const session: Session = {
      id: randomUUID(), ownerKey: randomBytes(32).toString("hex"), bootstrapKey: randomBytes(32).toString("hex"),
      workspaceId, clientId, directory, presentation, created: this.now(), touched: this.now(), lastSeen: 0,
      dirty: false, known: false, sequence: 0, snapshots: new Map(), requests: new Map(),
    };
    this.sessions.set(session.id, session);
    return { sessionId: session.id, ownerKey: session.ownerKey, bootstrapKey: session.bootstrapKey, directory, protocolVersion: 2 as const };
  }
  authorize(sessionId: string, ownerKey: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || !sameSecret(session.ownerKey, ownerKey)) throw new Error("Editor session is unavailable. Reconnect this panel.");
    session.touched = this.now();
    return session;
  }
  async bind(bootstrapKey: string, workspace: string, windowId: string, connectionId: string, socket: Socket): Promise<Session> {
    const session = [...this.sessions.values()].find((candidate) => sameSecret(candidate.bootstrapKey, bootstrapKey));
    if (!session) throw new Error("Pairing is unavailable. Reconnect from Paseo.");
    if (!session.bound && this.now() - session.created > BOOTSTRAP_TTL_MS) throw new Error("Pairing expired. Reconnect from Paseo.");
    if (session.bound && (session.bound.windowId !== windowId || session.bound.connectionId !== connectionId)) throw new Error("Pairing belongs to another editor window.");
    if (session.socket && session.socket !== socket && !session.socket.destroyed) throw new Error("Editor window is already connected.");
    const actual = await realpath(workspace);
    if (actual !== await realpath(session.directory)) throw new Error("Editor workspace does not match the Paseo workspace.");
    // Validate again after asynchronous filesystem access: two windows may race.
    if (!this.sessions.has(session.id) || (!session.bound && this.now() - session.created > BOOTSTRAP_TTL_MS) || (session.bound && (session.bound.windowId !== windowId || session.bound.connectionId !== connectionId)) ||
      (session.socket && session.socket !== socket && !session.socket.destroyed)) throw new Error("Pairing has already been claimed.");
    if (socket.destroyed) throw new Error("Editor disconnected during pairing.");
    session.bound = { windowId, connectionId };
    session.socket = socket; session.lastSeen = this.now(); session.known = false;
    return session;
  }
  update(session: Session, sequence: number, dirty: boolean, activeFile?: string | null) {
    if (sequence <= session.sequence) return;
    session.sequence = sequence; session.dirty = dirty; session.known = true; session.lastSeen = this.now();
    // Omitted means no observation for this sequence; null is an explicit
    // no-revealable-active-file observation.
    if (activeFile !== undefined) session.activeFile = activeFile;
  }
  state(session: Session): SessionState {
    const connected = !!session.socket && !session.socket.destroyed && this.now() - session.lastSeen < 20_000;
    return { connected, known: connected && session.known, dirty: session.dirty, sequence: session.sequence,
      expired: !session.bound && this.now() - session.created > BOOTSTRAP_TTL_MS,
      ...(session.activeFile !== undefined ? { activeFile: session.activeFile } : {}) };
  }
  async freshState(session: Session): Promise<SessionState> {
    if (!session.socket || session.socket.destroyed) return { ...this.state(session), known: false };
    if (session.snapshots.size >= 8) throw new Error("Too many pending editor state requests.");
    const requestId = randomUUID();
    return new Promise<SessionState>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.snapshots.delete(requestId);
        reject(new Error("The editor did not confirm its current unsaved state."));
      }, 5000);
      timer.unref?.();
      session.snapshots.set(requestId, { resolve, reject, timer });
      session.socket!.write(JSON.stringify({ protocol: 2, type: "getState", requestId }) + "\n");
    });
  }
  snapshot(session: Session, requestId: string, sequence: number, dirty: boolean, activeFile?: string | null) {
    const pending = session.snapshots.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer); session.snapshots.delete(requestId);
    if (sequence <= session.sequence) {
      pending.reject(new Error("The editor returned stale state. Reconnect before discarding edits."));
      return;
    }
    this.update(session, sequence, dirty, activeFile);
    pending.resolve(this.state(session));
  }
  /**
   * Reserve the request identity and fingerprint before the socket write. A
   * duplicate with the same fingerprint joins this receipt; a conflicting reuse
   * fails without writing. Expected non-admission is returned as a receipt so a
   * transport error can never be mistaken for authoritative not-sent evidence.
   */
  open(session: Session, requestId: string, target: FileTarget): Promise<FileOpenReceipt> {
    const targetFingerprint = fingerprint(target);
    // Expired receipts are UNKNOWN. Never let an expired identity masquerade as a
    // live duplicate; only a still-retained matching receipt joins.
    this.pruneReceipts(session);
    const existing = session.requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== targetFingerprint) return Promise.reject(new Error("Request identifier was reused for a different file."));
      // A refined terminal receipt is newer than the already-resolved promise.
      return terminalOutcome(existing.receipt.outcome) ? Promise.resolve({ ...existing.receipt }) : existing.promise;
    }
    const state = this.state(session);
    if (!state.known) return Promise.resolve(this.transient(session, requestId, targetFingerprint, "queue", "not_sent", false, "not_ready"));
    const pending = [...session.requests.values()].filter((entry) => !terminalOutcome(entry.receipt.outcome)).length;
    if (pending >= MAX_PENDING_REQUESTS) return Promise.resolve(this.transient(session, requestId, targetFingerprint, "queue", "not_sent", false, "capacity"));
    const socket = session.socket;
    if (!socket || socket.destroyed) return Promise.resolve(this.transient(session, requestId, targetFingerprint, "bridge", "not_sent", false, "bridge_unavailable"));
    const entry = this.store(session, requestId, targetFingerprint, "execution", "pending", false);
    // Admission must fail before reservation/dispatch if no receipt slot exists.
    if (!entry) return Promise.resolve(this.ephemeral(requestId, "queue", "not_sent", false, "capacity"));
    // Identity is reserved in the session before any bytes can leave this process.
    entry.receipt = { ...entry.receipt, outcome: "sent", dispatched: true, updatedAt: this.now(), expiresAt: this.now() + RECEIPT_TTL_MS };
    try {
      socket.write(JSON.stringify({ protocol: 2, type: "openFile", requestId, target }) + "\n");
    } catch {
      // A throw from write is not authoritative non-admission; the peer may have
      // received bytes, so keep the conservative uncertain outcome.
      this.settle(entry, "execution", "uncertain", true, "bridge_unavailable");
      return entry.promise;
    }
    entry.timer = setTimeout(() => this.settle(entry, "execution", "uncertain", true, "timeout"), RESPONSE_MS);
    entry.timer.unref?.();
    return entry.promise;
  }
  receipt(session: Session, requestId: string): FileOpenReceipt | undefined {
    this.pruneReceipts(session);
    const receipt = session.requests.get(requestId)?.receipt;
    return receipt ? { ...receipt } : undefined;
  }
  /**
   * Best effort only. Before dispatch cancellation is authoritative not-sent and
   * returns true. After a write it sends an advisory cancel, keeps the outcome
   * uncertain and returns false: the editor may already have run the request.
   */
  cancel(session: Session, requestId: string): boolean {
    const entry = session.requests.get(requestId);
    if (!entry || terminalOutcome(entry.receipt.outcome)) return false;
    if (entry.receipt.dispatched) {
      try { session.socket?.write(JSON.stringify({ protocol: 2, type: "cancel", requestId }) + "\n"); } catch { /* Outcome stays uncertain. */ }
      this.settle(entry, "execution", "uncertain", true, "cancelled");
      return false;
    }
    this.settle(entry, entry.receipt.stage, "not_sent", false, "cancelled");
    return true;
  }
  result(session: Session, requestId: string, ok: boolean, _error?: string) {
    const entry = session.requests.get(requestId);
    if (!entry) return;
    if (entry.receipt.outcome === "sent") {
      if (ok) this.settle(entry, "ack", "opened", true);
      else this.settle(entry, "ack", "failed", true);
      return;
    }
    // A late authoritative same-session result refines uncertainty without
    // resending or reusing the request identity.
    if (entry.receipt.outcome === "uncertain") this.refine(entry, ok);
  }
  disconnected(session: Session, socket: Socket) {
    if (session.socket !== socket) return;
    session.socket = undefined; session.known = false;
    for (const entry of session.requests.values()) {
      if (entry.receipt.outcome === "sent") this.settle(entry, entry.receipt.stage, "uncertain", true, "disconnected");
    }
    for (const [id, pending] of session.snapshots) { clearTimeout(pending.timer); pending.reject(new Error("The editor disconnected before confirming its unsaved state.")); session.snapshots.delete(id); }
  }
  release(session: Session) {
    this.sessions.delete(session.id);
    for (const entry of session.requests.values()) {
      if (!terminalOutcome(entry.receipt.outcome)) this.settle(entry, entry.receipt.stage, "uncertain", entry.receipt.dispatched, "session_closed");
    }
    const socket = session.socket;
    if (socket) { this.disconnected(session, socket); socket.destroy(); }
  }
  prune() {
    for (const session of this.sessions.values()) {
      if (this.now() - session.touched > LEASE_MS) this.release(session);
      else this.pruneReceipts(session);
    }
  }
  dispose() { for (const session of this.sessions.values()) this.release(session); }

  /** Returns undefined when no receipt slot is available: no reservation, no send. */
  private store(session: Session, requestId: string, fingerprint: string, stage: FileOpenStage,
    outcome: FileOpenReceipt["outcome"], dispatched: boolean, reason?: FileOpenReason): RequestEntry | undefined {
    this.pruneReceipts(session);
    if (!session.requests.has(requestId) && session.requests.size >= MAX_RECEIPTS && !this.evictOne(session)) return undefined;
    const at = this.now();
    let resolve!: (receipt: FileOpenReceipt) => void;
    const promise = new Promise<FileOpenReceipt>((accept) => { resolve = accept; });
    const receipt: FileOpenReceipt = {
      version: 2, correlationId: requestId, requestId, stage, outcome, dispatched,
      ...(reason ? { reason } : {}), updatedAt: at, expiresAt: at + RECEIPT_TTL_MS,
    };
    const entry = { fingerprint, receipt, promise, resolve };
    session.requests.set(requestId, entry);
    // A pre-dispatch rejection is itself the final receipt; resolve it now so a
    // duplicate joins a settled identity instead of hanging.
    if (terminalOutcome(outcome)) entry.resolve({ ...receipt });
    return entry;
  }
  /** Capacity rejection is stored when a slot exists; otherwise it stays ephemeral. */
  private transient(session: Session, requestId: string, targetFingerprint: string, stage: FileOpenStage,
    outcome: FileOpenReceipt["outcome"], dispatched: boolean, reason: FileOpenReason): FileOpenReceipt {
    const entry = this.store(session, requestId, targetFingerprint, stage, outcome, dispatched, reason);
    return entry ? entry.receipt : this.ephemeral(requestId, stage, "not_sent", false, "capacity");
  }
  private ephemeral(requestId: string, stage: FileOpenStage, outcome: FileOpenReceipt["outcome"],
    dispatched: boolean, reason: FileOpenReason): FileOpenReceipt {
    const at = this.now();
    return { version: 2, correlationId: requestId, requestId, stage, outcome, dispatched, reason,
      updatedAt: at, expiresAt: at + RECEIPT_TTL_MS };
  }
  private refine(entry: RequestEntry, ok: boolean) {
    const at = this.now();
    const receipt: FileOpenReceipt = {
      ...entry.receipt, stage: "ack", outcome: ok ? "opened" : "failed", dispatched: true,
      updatedAt: at, expiresAt: at + RECEIPT_TTL_MS,
    };
    delete receipt.reason;
    entry.receipt = receipt;
  }
  private settle(entry: RequestEntry, stage: FileOpenStage, outcome: FileOpenReceipt["outcome"],
    dispatched: boolean, reason?: FileOpenReason) {
    if (terminalOutcome(entry.receipt.outcome)) return;
    if (entry.timer) clearTimeout(entry.timer);
    const at = this.now();
    entry.receipt = {
      ...entry.receipt, stage, outcome, dispatched, ...(reason ? { reason } : { reason: undefined }),
      updatedAt: at, expiresAt: at + RECEIPT_TTL_MS,
    };
    if (!reason) delete entry.receipt.reason;
    entry.resolve({ ...entry.receipt });
  }
  private pruneReceipts(session: Session) {
    for (const [id, entry] of session.requests) {
      if (terminalOutcome(entry.receipt.outcome) && this.now() >= entry.receipt.expiresAt) {
        session.requests.delete(id);
      }
    }
    while (session.requests.size > MAX_RECEIPTS && this.evictOne(session)) { /* bounded */ }
  }
  /**
   * Only expired entries (removed by prune) and ordinary terminal receipts are
   * evictable. A non-expired uncertain outcome is retained until its TTL; when no
   * such slot exists admission rejects capacity before reservation or dispatch.
   */
  private evictOne(session: Session): boolean {
    const entries = [...session.requests.entries()].filter(([, entry]) =>
      terminalOutcome(entry.receipt.outcome) && entry.receipt.outcome !== "uncertain");
    if (!entries.length) return false;
    entries.sort((left, right) => left[1].receipt.updatedAt - right[1].receipt.updatedAt);
    session.requests.delete(entries[0]![0]);
    return true;
  }
}
function fingerprint(target: FileTarget): string {
  const canonical: Record<string, string | number> = { path: target.path };
  if (target.line !== undefined) canonical.line = target.line;
  if (target.column !== undefined) canonical.column = target.column;
  if (target.lineEnd !== undefined) canonical.lineEnd = target.lineEnd;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
function sameSecret(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
