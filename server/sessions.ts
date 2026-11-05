import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Socket } from "node:net";
import type { FileTarget } from "../shared/wire";
import type { SessionState } from "../shared/rpc";

export const BOOTSTRAP_TTL_MS = 120_000;
const LEASE_MS = 30 * 60_000;
const RESPONSE_MS = 15_000;
export interface Session {
  id: string; ownerKey: string; bootstrapKey: string; workspaceId: string; directory: string;
  clientId: string; created: number; touched: number; bound?: { windowId: string; connectionId: string };
  socket?: Socket; lastSeen: number; dirty: boolean; known: boolean; sequence: number;
  pending: Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
  snapshots: Map<string, { resolve(state: SessionState): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
  requests: Map<string, { fingerprint: string; result: Promise<void> }>;
}
export class EditorSessions {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly now: () => number = Date.now) {}
  create(workspaceId: string, clientId: string, directory: string) {
    this.prune();
    if (this.sessions.size >= 64) throw new Error("Too many editor sessions. Close unused Codium panels and retry.");
    const session: Session = {
      id: randomUUID(), ownerKey: randomBytes(32).toString("hex"), bootstrapKey: randomBytes(32).toString("hex"),
      workspaceId, clientId, directory, created: this.now(), touched: this.now(), lastSeen: 0,
      dirty: false, known: false, sequence: 0, pending: new Map(), snapshots: new Map(), requests: new Map(),
    };
    this.sessions.set(session.id, session);
    return { sessionId: session.id, ownerKey: session.ownerKey, bootstrapKey: session.bootstrapKey, directory, protocolVersion: 1 as const };
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
  update(session: Session, sequence: number, dirty: boolean) {
    if (sequence <= session.sequence) return;
    session.sequence = sequence; session.dirty = dirty; session.known = true; session.lastSeen = this.now();
  }
  state(session: Session): SessionState {
    const connected = !!session.socket && !session.socket.destroyed && this.now() - session.lastSeen < 20_000;
    return { connected, known: connected && session.known, dirty: session.dirty, sequence: session.sequence,
      expired: !session.bound && this.now() - session.created > BOOTSTRAP_TTL_MS };
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
      session.socket!.write(JSON.stringify({ protocol: 1, type: "getState", requestId }) + "\n");
    });
  }
  snapshot(session: Session, requestId: string, sequence: number, dirty: boolean) {
    const pending = session.snapshots.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer); session.snapshots.delete(requestId);
    if (sequence <= session.sequence) {
      pending.reject(new Error("The editor returned stale state. Reconnect before discarding edits."));
      return;
    }
    this.update(session, sequence, dirty);
    pending.resolve(this.state(session));
  }
  async open(session: Session, requestId: string, target: FileTarget): Promise<void> {
    const fingerprint = JSON.stringify(target);
    const existing = session.requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Request identifier was reused for a different file.");
      return existing.result;
    }
    if (!this.state(session).known) throw new Error("The editor has not confirmed it is ready.");
    if (session.pending.size >= 16) throw new Error("Too many pending file requests.");
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(requestId); reject(new Error("The editor did not acknowledge opening the file.")); }, RESPONSE_MS);
      timer.unref?.();
      session.pending.set(requestId, { resolve, reject, timer });
      session.socket!.write(JSON.stringify({ protocol: 1, type: "openFile", requestId, target }) + "\n");
    });
    session.requests.set(requestId, { fingerprint, result });
    // A cached rejection remains handled even if the transport caller disappears.
    void result.catch(() => {});
    for (const id of session.requests.keys()) {
      if (session.requests.size <= 64) break;
      if (!session.pending.has(id)) session.requests.delete(id);
    }
    return result;
  }
  result(session: Session, requestId: string, ok: boolean, error?: string) {
    const pending = session.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer); session.pending.delete(requestId);
    if (ok) pending.resolve(); else pending.reject(new Error(error || "The editor could not open that file."));
  }
  disconnected(session: Session, socket: Socket) {
    if (session.socket !== socket) return;
    session.socket = undefined; session.known = false;
    for (const [id, pending] of session.pending) { clearTimeout(pending.timer); pending.reject(new Error("The editor disconnected before confirming the request.")); session.pending.delete(id); }
    for (const [id, pending] of session.snapshots) { clearTimeout(pending.timer); pending.reject(new Error("The editor disconnected before confirming its unsaved state.")); session.snapshots.delete(id); }
  }
  release(session: Session) {
    this.sessions.delete(session.id);
    const socket = session.socket;
    if (socket) { this.disconnected(session, socket); socket.destroy(); }
  }
  prune() { for (const session of this.sessions.values()) if (this.now() - session.touched > LEASE_MS) this.release(session); }
  dispose() { for (const session of this.sessions.values()) this.release(session); }
}
function sameSecret(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
