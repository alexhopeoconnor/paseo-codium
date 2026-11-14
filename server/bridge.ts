import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { MessageFramer, PROTOCOL_VERSION, parseCompanionMessage, type CompanionMessage } from "../shared/wire";
import { EditorSessions, type Session } from "./sessions";

const MAX_QUEUED_CONTROLS = 32;
const MAX_QUEUED_MESSAGES = 64;

export function bridgeSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : "");
  if (!runtime || !isAbsolute(runtime)) throw new Error("A local user runtime directory is required for embedded Codium.");
  return join(runtime, "paseo-codium", "bridge.sock");
}

export class EditorBridge {
  readonly sessions = new EditorSessions();
  readonly ready: Promise<void>;
  private readonly server = createServer((socket) => this.accept(socket));
  private readonly sockets = new Set<Socket>();
  private disposed = false;
  private socketInode?: number;
  private readonly pruneTimer = setInterval(() => this.sessions.prune(), 60_000);
  constructor(readonly path = bridgeSocketPath()) {
    this.pruneTimer.unref?.();
    this.ready = this.start();
    void this.ready.catch(() => {});
  }
  private async start() {
    const directory = join(this.path, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Editor bridge directory must be owned by this user with mode 0700.");
    if (Buffer.byteLength(this.path) > 100) throw new Error("Editor bridge socket path is too long.");
    try {
      const old = await lstat(this.path);
      if (!old.isSocket() || old.uid !== process.getuid?.()) throw new Error("Refusing to replace an unexpected editor bridge path.");
      const live = await new Promise<boolean>((resolve, reject) => {
        const probe = createConnection(this.path);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
          else reject(new Error("Cannot safely inspect the existing editor bridge socket."));
        });
        probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
      });
      if (live) throw new Error("Another Codium editor bridge is already running.");
      const again = await lstat(this.path);
      if (again.ino !== old.ino || !again.isSocket()) throw new Error("Editor bridge path changed during startup.");
      await unlink(this.path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.disposed) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => { this.server.removeListener("error", reject); resolve(); });
    });
    await chmod(this.path, 0o600);
    this.socketInode = (await lstat(this.path)).ino;
    this.server.on("error", () => { /* RPC readiness/connection state reports errors without session data. */ });
    if (this.disposed) this.dispose();
  }
  private accept(socket: Socket) {
    if (this.sockets.size >= 64) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    const framer = new MessageFramer();
    const queue: CompanionMessage[] = [];
    let session: Session | undefined;
    let running = false;
    let failed = false;
    let controlCount = 0;
    const reject = () => {
      if (failed) return;
      failed = true; queue.length = 0;
      // Never echo malformed messages, keys, paths or raw parse errors.
      const payload = JSON.stringify({ protocol: PROTOCOL_VERSION, type: "error", message: "Editor connection rejected. Check the matching plugin and companion versions, then reconnect from Paseo." }) + "\n";
      socket.end(payload, () => socket.destroy());
    };
    const handle = async (message: CompanionMessage) => {
      if (message.type === "hello") {
        if (session) throw new Error("Editor is already bound.");
        session = await this.sessions.bind(message.bootstrapKey, message.workspace, message.windowId, message.connectionId, socket);
        socket.write(JSON.stringify({ protocol: PROTOCOL_VERSION, type: "bound", sessionId: session.id }) + "\n");
        if (session.presentation.closePrimarySidebar) {
          socket.write(JSON.stringify({ protocol: PROTOCOL_VERSION, type: "presentation", primarySidebar: "close-once" }) + "\n");
        }
      } else {
        if (!session) throw new Error("Pair this editor before sending state.");
        if (message.type === "state") this.sessions.update(session, message.sequence, message.dirty, message.activeFile);
        else if (message.type === "snapshot") this.sessions.snapshot(session, message.requestId, message.sequence, message.dirty, message.activeFile);
        else this.sessions.result(session, message.requestId, message.ok, message.error);
      }
    };
    const pump = () => {
      if (running || failed) return;
      running = true;
      void (async () => {
        while (!failed) {
          const message = queue.shift();
          if (!message) break;
          if (message.type !== "state") controlCount--;
          try { await handle(message); } catch { reject(); return; }
        }
      })().finally(() => {
        running = false;
        if (!failed && queue.length) pump();
      });
    };
    socket.on("data", (data: Buffer) => {
      if (failed) return;
      let frames: Uint8Array[];
      try { frames = framer.push(data); } catch { reject(); return; }
      for (const frame of frames) {
        let message: CompanionMessage;
        try { message = parseCompanionMessage(JSON.parse(Buffer.from(frame).toString("utf8"))); } catch { reject(); return; }
        if (message.type === "state") {
          // Only a consecutive replaceable state run coalesces. A control message
          // is a barrier: later state can never move ahead of it, preserving order.
          const last = queue[queue.length - 1];
          if (last?.type === "state") queue[queue.length - 1] = message;
          else {
            if (queue.length >= MAX_QUEUED_MESSAGES) { socket.destroy(); return; }
            queue.push(message);
          }
        } else {
          if (++controlCount > MAX_QUEUED_CONTROLS || queue.length >= MAX_QUEUED_MESSAGES) { socket.destroy(); return; }
          queue.push(message);
        }
      }
      pump();
    });
    socket.on("error", () => {});
    socket.on("close", () => { this.sockets.delete(socket); if (session) this.sessions.disconnected(session, socket); });
  }
  dispose() {
    this.disposed = true; clearInterval(this.pruneTimer); this.sessions.dispose();
    for (const socket of this.sockets) socket.destroy();
    this.server.close(() => {
      void lstat(this.path).then((info) => {
        if (this.socketInode && info.ino === this.socketInode && info.isSocket()) return unlink(this.path);
      }).catch(() => {});
    });
  }
}
