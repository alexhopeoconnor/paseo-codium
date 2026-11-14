import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MessageFramer, PROTOCOL_VERSION, parseBrokerMessage, type FileTarget } from "../../shared/wire";

const MAX_RESULTS = 64;
interface ResultEntry {
  fingerprint: string;
  promise: Promise<void>;
  settled: boolean;
  ok?: boolean;
  cancelled: boolean;
  delivered: boolean;
}
interface EditorAdapter {
  windowId: string;
  workspace: string;
  dirty(): boolean;
  activeFile(): string | null;
  open(target: FileTarget, isCurrent: () => boolean): Promise<void>;
  /** Presentation command; the host editor may not expose this action. */
  closePrimarySidebar?(): void | Promise<void>;
  status(connected: boolean): void;
}
export class BridgeClient {
  private socket?: Socket;
  private capability?: string;
  private pairing?: Promise<void>;
  private sequence = 0;
  private bound = false;
  private disposed = false;
  private rejected = false;
  private generation = 0;
  private sidebarApplied = false;
  private readonly connectionId = randomUUID();
  private reconnect?: ReturnType<typeof setTimeout>;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private readonly heartbeat = setInterval(() => this.sendState(), 5000);
  private readonly results = new Map<string, ResultEntry>();
  constructor(private readonly editor: EditorAdapter) { this.heartbeat.unref?.(); }
  pair(capability: string): Promise<void> {
    if (this.disposed || this.rejected) return Promise.reject(new Error("This editor binding is no longer available. Reconnect from Paseo."));
    if (this.capability && this.capability !== capability) return Promise.reject(new Error("This editor is already paired. Reopen the intended Paseo panel."));
    if (this.pairing) return this.pairing;
    this.capability = capability;
    const attempt = this.connect();
    this.pairing = attempt;
    // A missing socket or dropped initial connection is retryable. Protocol
    // rejection and a different capability remain terminal for this window.
    void attempt.catch(() => { if (this.pairing === attempt) this.pairing = undefined; });
    return attempt;
  }
  private async connect(): Promise<void> {
    if (this.disposed || this.rejected) throw new Error("Editor pairing is unavailable.");
    const generation = ++this.generation;
    const runtime = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : "");
    if (!isAbsolute(runtime)) throw new Error("A user runtime directory is required.");
    const directory = join(runtime, "paseo-codium");
    const path = join(directory, "bridge.sock");
    const [dir, file] = await Promise.all([lstat(directory), lstat(path)]);
    if (this.disposed || this.rejected || generation !== this.generation) throw new Error("Editor pairing is unavailable.");
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) ||
      !file.isSocket() || file.uid !== process.getuid?.() || (file.mode & 0o077)) throw new Error("The Paseo editor bridge has unexpected ownership or permissions.");
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path); this.socket = socket;
      const framer = new MessageFramer(); let settled = false;
      const isCurrent = () => !this.disposed && !this.rejected && generation === this.generation && this.socket === socket && !socket.destroyed;
      const timeout = setTimeout(() => { if (!settled) reject(new Error("Paseo did not confirm editor pairing.")); socket.destroy(); }, 10_000);
      timeout.unref?.();
      socket.on("connect", () => {
        if (!isCurrent()) { socket.destroy(); return; }
        socket.write(JSON.stringify({ protocol: PROTOCOL_VERSION, type: "hello", bootstrapKey: this.capability, windowId: this.editor.windowId,
          connectionId: this.connectionId, workspace: this.editor.workspace }) + "\n");
      });
      socket.on("data", (chunk: Buffer) => {
        if (!isCurrent()) { socket.destroy(); return; }
        let frames: Uint8Array[];
        try { frames = framer.push(chunk); } catch { this.rejected = true; socket.destroy(); return; }
        for (const frame of frames) {
          const line = Buffer.from(frame).toString("utf8");
          try {
            const message = parseBrokerMessage(JSON.parse(line));
            if (message.type === "bound") {
              if (this.bound) throw new Error("Duplicate binding.");
              this.bound = true; settled = true; clearTimeout(timeout); this.editor.status(true); this.sendState();
              // Deliver any operation result that settled while disconnected.
              for (const [requestId, entry] of this.results) if (entry.settled) this.deliver(requestId, entry);
              resolve();
            } else if (message.type === "error") {
              this.rejected = true; if (!settled) reject(new Error(message.message)); socket.destroy(); return;
            } else if (message.type === "presentation") {
              if (!this.bound) throw new Error("Editor is not paired.");
              // Once per Codium window, across reconnects. A user who reopens the
              // sidebar afterward must not have it closed again.
              if (!this.sidebarApplied) {
                this.sidebarApplied = true;
                try { void Promise.resolve(this.editor.closePrimarySidebar?.()).catch(() => {}); } catch { /* Optional presentation. */ }
              }
            } else if (message.type === "cancel") {
              if (!this.bound) throw new Error("Editor is not paired.");
              const entry = this.results.get(message.requestId);
              if (entry && !entry.settled) entry.cancelled = true;
            } else {
              if (!this.bound) throw new Error("Editor is not paired.");
              if (message.type === "getState") {
                socket.write(JSON.stringify({ protocol: PROTOCOL_VERSION, type: "snapshot", requestId: message.requestId, sequence: ++this.sequence,
                  dirty: this.editor.dirty(), activeFile: this.editor.activeFile() }) + "\n");
                continue;
              }
              this.open(message.requestId, message.target, isCurrent);
            }
          } catch { this.rejected = true; if (!settled) reject(new Error("Editor protocol is incompatible. Check the installed companion version.")); socket.destroy(); return; }
        }
      });
      socket.on("error", () => { if (!settled) reject(new Error("The Paseo editor bridge is unavailable.")); });
      socket.on("close", () => {
        clearTimeout(timeout); if (!settled) reject(new Error("The editor bridge disconnected during pairing."));
        if (generation !== this.generation || this.socket !== socket) return;
        this.socket = undefined;
        this.bound = false; this.editor.status(false);
        // Keep in-flight operation identities until they settle. Deleting them on
        // disconnect would let a duplicate execute the same file again after
        // reconnect. Bounded capacity rejects new work rather than evicting them.
        if (!this.disposed && !this.rejected && settled) this.scheduleReconnect();
      });
    });
  }
  private open(requestId: string, target: FileTarget, isCurrent: () => boolean) {
    const fingerprint = JSON.stringify(target);
    const prior = this.results.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        this.reply(requestId, false, "Request identifier conflict.");
        return;
      }
      if (prior.settled) {
        // A duplicate may follow a lost result after reconnect; re-deliver the
        // same authoritative outcome idempotently instead of executing again.
        prior.delivered = false;
        this.deliver(requestId, prior);
      }
      return;
    }
    if (this.results.size >= MAX_RESULTS && !this.evictSettled()) {
      this.reply(requestId, false, "Too many pending file requests.");
      return;
    }
    // Reserve the identity before invoking the editor operation. A duplicate
    // joins this entry instead of opening the file a second time.
    let resolveOpen!: () => void;
    let rejectOpen!: (error: Error) => void;
    const promise = new Promise<void>((accept, reject) => { resolveOpen = accept; rejectOpen = reject; });
    const entry: ResultEntry = { fingerprint, promise, settled: false, cancelled: false, delivered: false };
    this.results.set(requestId, entry);
    // Defer the editor continuation one microtask so an advisory cancel in the
    // same socket batch can stop a not-yet-started open. Once started, Codium's
    // API cannot be undone; the outcome then remains uncertain.
    void Promise.resolve().then(() => {
      if (entry.cancelled || this.disposed || !isCurrent()) {
        entry.settled = true; entry.ok = false;
        this.trimResults();
        return;
      }
      return this.editor.open(target, isCurrent).then(resolveOpen, rejectOpen);
    });
    void promise.then(
      () => {
        entry.settled = true; entry.ok = true;
        // Reply on the current transport if this operation settles after a
        // reconnect. The request identity, not the old socket lifetime, owns it.
        this.deliver(requestId, entry);
        this.trimResults();
      },
      () => {
        entry.settled = true; entry.ok = false;
        this.deliver(requestId, entry);
        this.trimResults();
      },
    );
  }
  private deliver(requestId: string, entry: ResultEntry) {
    if (entry.cancelled || entry.delivered || !this.bound || !this.socket || this.socket.destroyed) return;
    entry.delivered = true;
    this.reply(requestId, entry.ok === true, entry.ok === true ? undefined : "Codium could not open the file. Check that it exists and is readable.");
  }
  private evictSettled(): boolean {
    for (const [requestId, entry] of this.results) {
      if (entry.settled) { this.results.delete(requestId); return true; }
    }
    return false;
  }
  private trimResults() {
    while (this.results.size > MAX_RESULTS && this.evictSettled()) { /* bounded */ }
  }
  private scheduleReconnect() {
    if (this.disposed || this.rejected) return;
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => { void this.connect().catch(() => { if (!this.disposed && !this.rejected) this.scheduleReconnect(); }); }, 3000);
    this.reconnect.unref?.();
  }
  private reply(requestId: string, ok: boolean, error?: string) {
    if (!this.disposed && this.bound) this.socket?.write(JSON.stringify({ protocol: PROTOCOL_VERSION, type: "result", requestId, ok, ...(error ? { error } : {}) }) + "\n");
    this.sendState();
  }
  sendState() {
    if (!this.disposed && this.bound && this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify({ protocol: PROTOCOL_VERSION, type: "state", sequence: ++this.sequence,
        dirty: this.editor.dirty(), activeFile: this.editor.activeFile() }) + "\n");
    }
  }
  /** Coalesce editor-event state sends; heartbeat and replies stay immediate. */
  requestState() {
    if (this.disposed || !this.bound || this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.sendState();
    }, 50);
    this.stateTimer.unref?.();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.bound = false;
    clearInterval(this.heartbeat); clearTimeout(this.reconnect); clearTimeout(this.stateTimer);
    const socket = this.socket; this.socket = undefined; socket?.destroy();
    this.editor.status(false);
  }
}
