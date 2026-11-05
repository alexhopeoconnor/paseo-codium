import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MessageFramer, parseBrokerMessage, type FileTarget } from "../../shared/wire";

interface EditorAdapter {
  windowId: string;
  workspace: string;
  dirty(): boolean;
  open(target: FileTarget, isCurrent: () => boolean): Promise<void>;
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
  private readonly connectionId = randomUUID();
  private reconnect?: ReturnType<typeof setTimeout>;
  private readonly heartbeat = setInterval(() => this.sendState(), 5000);
  private readonly results = new Map<string, { fingerprint: string; promise: Promise<void> }>();
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
        socket.write(JSON.stringify({ protocol: 1, type: "hello", bootstrapKey: this.capability, windowId: this.editor.windowId,
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
              this.bound = true; settled = true; clearTimeout(timeout); this.editor.status(true); this.sendState(); resolve();
            } else if (message.type === "error") {
              this.rejected = true; if (!settled) reject(new Error(message.message)); socket.destroy(); return;
            } else {
              if (!this.bound) throw new Error("Editor is not paired.");
              if (message.type === "getState") {
                socket.write(JSON.stringify({ protocol: 1, type: "snapshot", requestId: message.requestId, sequence: ++this.sequence, dirty: this.editor.dirty() }) + "\n");
                continue;
              }
              const fingerprint = JSON.stringify(message.target);
              const prior = this.results.get(message.requestId);
              if (prior && prior.fingerprint !== fingerprint) throw new Error("Request identity conflict.");
              const promise = prior?.promise ?? this.editor.open(message.target, isCurrent);
              this.results.set(message.requestId, { fingerprint, promise });
              while (this.results.size > 64) this.results.delete(this.results.keys().next().value!);
              void promise.then(
                () => { if (isCurrent()) this.reply(message.requestId, true); },
                () => { if (isCurrent()) this.reply(message.requestId, false, "Codium could not open the file. Check that it exists and is readable."); },
              );
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
        if (!this.disposed && !this.rejected && settled) this.scheduleReconnect();
      });
    });
  }
  private scheduleReconnect() {
    if (this.disposed || this.rejected) return;
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => { void this.connect().catch(() => { if (!this.disposed && !this.rejected) this.scheduleReconnect(); }); }, 3000);
    this.reconnect.unref?.();
  }
  private reply(requestId: string, ok: boolean, error?: string) {
    if (!this.disposed && this.bound) this.socket?.write(JSON.stringify({ protocol: 1, type: "result", requestId, ok, ...(error ? { error } : {}) }) + "\n");
    this.sendState();
  }
  sendState() {
    if (!this.disposed && this.bound && this.socket && !this.socket.destroyed) this.socket.write(JSON.stringify({ protocol: 1, type: "state", sequence: ++this.sequence, dirty: this.editor.dirty() }) + "\n");
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.bound = false;
    clearInterval(this.heartbeat); clearTimeout(this.reconnect);
    const socket = this.socket; this.socket = undefined; socket?.destroy();
    this.editor.status(false);
  }
}
