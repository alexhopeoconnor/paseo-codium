import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorBridge } from "../server/bridge";
import { MAX_FRAME_BYTES } from "../shared/wire";

describe("Unix socket transport", () => {
  let directory: string;
  let bridge: EditorBridge | undefined;
  const sockets: Socket[] = [];
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "codium-bridge-test-")); });
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); bridge?.dispose(); await new Promise((resolve) => setTimeout(resolve, 20)); await rm(directory, { recursive: true, force: true }); });
  const connect = async (path: string) => { const socket = createConnection(path); sockets.push(socket); await once(socket, "connect"); return socket; };
  const collect = (socket: Socket) => {
    const messages: Array<Record<string, unknown>> = [];
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        messages.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    return messages;
  };
  const bind = async (socket: Socket, bootstrapKey: string) => {
    socket.write(JSON.stringify({ protocol: 2, type: "hello", bootstrapKey, windowId: "window_a", connectionId: "connection_a", workspace: directory }) + "\n");
  };

  it("creates an owner-only socket and accepts a real protocol 2 handshake/state exchange", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    expect((await lstat(bridge.path)).mode & 0o777).toBe(0o600);
    const created = bridge.sessions.create("workspace_a", "browser_a", directory);
    expect(created.protocolVersion).toBe(2);
    const socket = await connect(bridge.path);
    const messages = collect(socket);
    await bind(socket, created.bootstrapKey);
    await vi.waitFor(() => expect(messages[0]).toEqual({ protocol: 2, type: "bound", sessionId: created.sessionId }));
    socket.write(JSON.stringify({ protocol: 2, type: "state", sequence: 1, dirty: true }) + "\n");
    await vi.waitFor(() => expect(bridge!.sessions.state(bridge!.sessions.authorize(created.sessionId, created.ownerKey))).toMatchObject({ known: true, dirty: true }));
  });
  it("refuses to unlink an unexpected existing file", async () => {
    const path = join(directory, "bridge.sock"); await writeFile(path, "preserve");
    bridge = new EditorBridge(path);
    await expect(bridge.ready).rejects.toThrow("unexpected");
    expect((await lstat(path)).isFile()).toBe(true);
  });
  it("rejects oversized unframed input without processing it", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    const socket = await connect(bridge.path);
    socket.resume();
    const closed = once(socket, "close");
    socket.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 65));
    await closed;
    expect(socket.destroyed).toBe(true);
  });
  it("rejects an old protocol version with one generic message and no secret echo", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    const created = bridge.sessions.create("workspace_a", "browser_a", directory);
    const socket = await connect(bridge.path);
    const messages = collect(socket), closed = once(socket, "close");
    socket.write(JSON.stringify({ protocol: 1, type: "hello", bootstrapKey: created.bootstrapKey, windowId: "window_a", connectionId: "connection_a", workspace: directory }) + "\n");
    await closed;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ protocol: 2, type: "error" });
    expect(JSON.stringify(messages[0])).not.toContain(created.bootstrapKey);
  });
  it("coalesces a burst of 40 valid state frames without disconnecting", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    const created = bridge.sessions.create("workspace_a", "browser_a", directory);
    const socket = await connect(bridge.path);
    const messages = collect(socket);
    await bind(socket, created.bootstrapKey);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    const frames = Array.from({ length: 40 }, (_, index) => ({ protocol: 2, type: "state", sequence: index + 1, dirty: index % 2 === 0 }));
    socket.write(frames.map((frame) => JSON.stringify(frame) + "\n").join(""));
    await vi.waitFor(() => expect(bridge!.sessions.state(bridge!.sessions.authorize(created.sessionId, created.ownerKey))).toMatchObject({ known: true, sequence: 40, dirty: false }));
    expect(socket.destroyed).toBe(false);
    expect(messages).toHaveLength(1);
  });
  it("never reorders state across a control barrier", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    const created = bridge.sessions.create("workspace_a", "browser_a", directory);
    const socket = await connect(bridge.path);
    const messages = collect(socket);
    await bind(socket, created.bootstrapKey);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    const order: string[] = [];
    vi.spyOn(bridge.sessions, "update").mockImplementation(() => { order.push("state"); });
    vi.spyOn(bridge.sessions, "result").mockImplementation(() => { order.push("result"); });
    const first = Array.from({ length: 5 }, (_, index) => ({ protocol: 2, type: "state", sequence: index + 1, dirty: false }));
    const second = Array.from({ length: 5 }, (_, index) => ({ protocol: 2, type: "state", sequence: index + 6, dirty: true }));
    socket.write([
      ...first,
      { protocol: 2, type: "result", requestId: "request_barrier", ok: true },
      ...second,
    ].map((message) => JSON.stringify(message) + "\n").join(""));
    await vi.waitFor(() => expect(order).toEqual(["state", "result", "state"]));
    expect(socket.destroyed).toBe(false);
  });
  it("sends the one-time sidebar presentation command after binding when requested", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    const created = bridge.sessions.create("workspace_a", "browser_a", directory, { closePrimarySidebar: true });
    const socket = await connect(bridge.path);
    const messages = collect(socket);
    await bind(socket, created.bootstrapKey);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toEqual({ protocol: 2, type: "bound", sessionId: created.sessionId });
    expect(messages[1]).toEqual({ protocol: 2, type: "presentation", primarySidebar: "close-once" });
  });
  it("does not send a presentation command when the preference is off", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    const created = bridge.sessions.create("workspace_a", "browser_a", directory, { closePrimarySidebar: false });
    const socket = await connect(bridge.path);
    const messages = collect(socket);
    await bind(socket, created.bootstrapKey);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages).toHaveLength(1);
  });
});
