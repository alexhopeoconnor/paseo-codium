import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("creates owner-only socket and accepts a real handshake/state exchange", async () => {
    bridge = new EditorBridge(join(directory, "bridge.sock")); await bridge.ready;
    expect((await lstat(bridge.path)).mode & 0o777).toBe(0o600);
    const created = bridge.sessions.create("workspace_a", "browser_a", directory);
    const socket = await connect(bridge.path);
    const bound = once(socket, "data");
    socket.write(JSON.stringify({ protocol: 1, type: "hello", bootstrapKey: created.bootstrapKey, windowId: "window_a", connectionId: "connection_a", workspace: directory }) + "\n");
    const [data] = await bound;
    expect(JSON.parse(String(data))).toEqual({ protocol: 1, type: "bound", sessionId: created.sessionId });
    socket.write(JSON.stringify({ protocol: 1, type: "state", sequence: 1, dirty: true }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.sessions.state(bridge.sessions.authorize(created.sessionId, created.ownerKey))).toMatchObject({ known: true, dirty: true });
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
    const closed = once(socket, "close");
    socket.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 65));
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});
