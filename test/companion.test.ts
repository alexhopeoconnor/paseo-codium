import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeClient } from "../companion/src/bridge-client";
import { EditorBridge } from "../server/bridge";

describe("companion connection lifecycle", () => {
  let directory: string;
  let bridge: EditorBridge | undefined;
  const clients: BridgeClient[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codium-companion-test-"));
    vi.stubEnv("XDG_RUNTIME_DIR", directory);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    bridge?.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const start = async (closePrimarySidebar = false) => {
    bridge = new EditorBridge(join(directory, "paseo-codium", "bridge.sock"));
    await bridge.ready;
    return bridge.sessions.create("workspace_a", "client_a", directory, { closePrimarySidebar });
  };
  function client() {
    const status = vi.fn(), open = vi.fn(async (_target: unknown, _current: () => boolean) => {});
    const closePrimarySidebar = vi.fn();
    let activeFile: string | null = null;
    const instance = new BridgeClient({
      windowId: "window_a", workspace: directory, dirty: () => false, activeFile: () => activeFile,
      open, closePrimarySidebar, status,
    });
    clients.push(instance);
    return { instance, status, open, closePrimarySidebar, setActiveFile(value: string | null) { activeFile = value; } };
  }
  it("never binds after disposal during asynchronous socket inspection", async () => {
    const created = await start(), c = client();
    const pending = c.instance.pair(created.bootstrapKey);
    c.instance.dispose();
    await expect(pending).rejects.toThrow("unavailable");
    expect(c.status).not.toHaveBeenCalledWith(true);
    expect(bridge!.sessions.authorize(created.sessionId, created.ownerKey).bound).toBeUndefined();
  });
  it("can retry the same capability after an initial transport failure", async () => {
    const created = await start(), c = client();
    // Temporarily inspect a missing runtime; the server and capability stay valid.
    vi.stubEnv("XDG_RUNTIME_DIR", join(directory, "missing"));
    await expect(c.instance.pair(created.bootstrapKey)).rejects.toThrow();
    vi.stubEnv("XDG_RUNTIME_DIR", directory);
    await expect(c.instance.pair(created.bootstrapKey)).resolves.toBeUndefined();
    expect(c.status).toHaveBeenCalledWith(true);
    await expect(c.instance.pair("b".repeat(64))).rejects.toThrow("already paired");
  });
  it("does not retry a rejected bootstrap or accept another capability afterward", async () => {
    await start(); const c = client();
    await expect(c.instance.pair("a".repeat(64))).rejects.toThrow();
    await expect(c.instance.pair("a".repeat(64))).rejects.toThrow("no longer available");
    await expect(c.instance.pair("b".repeat(64))).rejects.toThrow("no longer available");
    expect(c.status).not.toHaveBeenCalledWith(true);
  });
  it("accepts several valid protocol 2 commands coalesced beyond one frame's limit", async () => {
    const created = await start(), c = client(); await c.instance.pair(created.bootstrapKey);
    const session = bridge!.sessions.authorize(created.sessionId, created.ownerKey);
    const messages = Array.from({ length: 5 }, (_, index) => ({ protocol: 2, type: "openFile", requestId: `request_${index}`,
      target: { path: "/" + "x".repeat(7000) + index } }));
    session.socket!.write(messages.map((message) => JSON.stringify(message) + "\n").join(""));
    await vi.waitFor(() => expect(c.open).toHaveBeenCalledTimes(5));
    expect(c.status).not.toHaveBeenLastCalledWith(false);
  });
  it("sends activeFile with manual tab changes, null observations and snapshots", async () => {
    const created = await start(), c = client(); await c.instance.pair(created.bootstrapKey);
    const session = bridge!.sessions.authorize(created.sessionId, created.ownerKey);
    await vi.waitFor(() => expect(bridge!.sessions.state(session).known).toBe(true));
    c.setActiveFile("src/a.ts");
    c.instance.sendState();
    await vi.waitFor(() => expect(bridge!.sessions.state(session).activeFile).toBe("src/a.ts"));
    // Rapid event requests coalesce to one state with the latest file.
    c.setActiveFile("src/b.ts");
    c.instance.requestState(); c.instance.requestState(); c.instance.requestState();
    await vi.waitFor(() => expect(bridge!.sessions.state(session).activeFile).toBe("src/b.ts"));
    c.setActiveFile(null);
    c.instance.sendState();
    await vi.waitFor(() => expect(bridge!.sessions.state(session).activeFile).toBeNull());
    c.setActiveFile("src/c.ts");
    await expect(bridge!.sessions.freshState(session)).resolves.toMatchObject({ activeFile: "src/c.ts" });
  });
  it("joins duplicate request identities before execution and fails conflicting reuse", async () => {
    const created = await start(), c = client(); await c.instance.pair(created.bootstrapKey);
    const socket = bridge!.sessions.authorize(created.sessionId, created.ownerKey).socket!;
    const replies: Array<Record<string, unknown>> = [];
    const framer = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        try { replies.push(JSON.parse(line)); } catch { /* partial */ }
      }
    };
    socket.on("data", framer);
    const command = { protocol: 2, type: "openFile", requestId: "request_duplicate", target: { path: "/same" } };
    socket.write(JSON.stringify(command) + "\n");
    socket.write(JSON.stringify(command) + "\n");
    await vi.waitFor(() => expect(c.open).toHaveBeenCalledOnce());
    socket.write(JSON.stringify({ protocol: 2, type: "openFile", requestId: "request_duplicate", target: { path: "/different" } }) + "\n");
    await vi.waitFor(() => expect(replies).toContainEqual(expect.objectContaining({ requestId: "request_duplicate", ok: false, error: "Request identifier conflict." })));
    expect(c.open).toHaveBeenCalledOnce();
  });
  it("applies the sidebar presentation command once per Codium window across reconnects", async () => {
    const created = await start(true), c = client(); await c.instance.pair(created.bootstrapKey);
    await vi.waitFor(() => expect(c.closePrimarySidebar).toHaveBeenCalledOnce());
    const session = bridge!.sessions.authorize(created.sessionId, created.ownerKey);
    session.socket!.destroy();
    await vi.waitFor(() => expect(c.status.mock.calls.filter(([connected]) => connected)).toHaveLength(2), { timeout: 5000 });
    expect(c.closePrimarySidebar).toHaveBeenCalledOnce();
  }, 10_000);
  it("invalidates the current-operation guard immediately on disposal", async () => {
    const created = await start(), c = client(); await c.instance.pair(created.bootstrapKey);
    const session = bridge!.sessions.authorize(created.sessionId, created.ownerKey);
    session.socket!.write(JSON.stringify({ protocol: 2, type: "openFile", requestId: "request_a", target: { path: "/file" } }) + "\n");
    await vi.waitFor(() => expect(c.open).toHaveBeenCalledOnce());
    const isCurrent = c.open.mock.calls[0]![1];
    expect(isCurrent()).toBe(true);
    c.instance.dispose();
    expect(isCurrent()).toBe(false);
  });
  it("retains an in-flight identity across reconnect, joins duplicates and delivers its authoritative result", async () => {
    const created = await start(), c = client(); await c.instance.pair(created.bootstrapKey);
    const session = bridge!.sessions.authorize(created.sessionId, created.ownerKey);
    const identity = { ...session.bound };
    await vi.waitFor(() => expect(bridge!.sessions.state(session).known).toBe(true));
    let complete!: () => void;
    c.open.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const command = bridge!.sessions.open(session, "request_slow", { path: "/slow" });
    await vi.waitFor(() => expect(c.open).toHaveBeenCalledOnce());
    session.socket!.destroy();
    await expect(command).resolves.toMatchObject({ outcome: "uncertain", reason: "disconnected", dispatched: true });
    await vi.waitFor(() => expect(c.status).toHaveBeenLastCalledWith(false));
    await vi.waitFor(() => expect(c.status.mock.calls.filter(([connected]) => connected)).toHaveLength(2), { timeout: 5000 });
    expect(session.bound).toEqual(identity);
    await vi.waitFor(() => expect(bridge!.sessions.state(session).known).toBe(true));
    // A duplicate after reconnect must join the still-running operation, not run it again.
    session.socket!.write(JSON.stringify({ protocol: 2, type: "openFile", requestId: "request_slow", target: { path: "/slow" } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.open).toHaveBeenCalledOnce();
    const result = vi.spyOn(bridge!.sessions, "result");
    complete();
    await vi.waitFor(() => expect(result.mock.calls[0]?.slice(0, 3)).toEqual([session, "request_slow", true]));
    expect(c.open).toHaveBeenCalledOnce();
  }, 10_000);
});
