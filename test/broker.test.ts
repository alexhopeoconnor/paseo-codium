import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { BOOTSTRAP_TTL_MS, EditorSessions } from "../server/sessions";

describe("exact-window editor broker", () => {
  let directory: string;
  let sessions: EditorSessions;
  let clock = 1000;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "paseo-codium-test-")); clock = 1000; sessions = new EditorSessions(() => clock); });
  afterEach(async () => { sessions.dispose(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
  const socket = () => new Socket();
  it("requires a panel's private owner credential", () => {
    const created = sessions.create("workspace_a", "client_a", directory);
    expect(() => sessions.authorize(created.sessionId, "0".repeat(64))).toThrow();
    expect(() => sessions.authorize(created.sessionId, "bad")).toThrow();
    expect(sessions.authorize(created.sessionId, created.ownerKey).directory).toBe(directory);
  });
  it("binds two browser windows on one folder independently and rejects replay", async () => {
    const a = sessions.create("workspace_a", "browser_a", directory);
    const b = sessions.create("workspace_a", "browser_b", directory);
    const first = await sessions.bind(a.bootstrapKey, directory, "window_a", "connection_a", socket());
    const second = await sessions.bind(b.bootstrapKey, directory, "window_b", "connection_b", socket());
    expect(first.id).not.toBe(second.id);
    await expect(sessions.bind(a.bootstrapKey, directory, "window_b", "connection_b", socket())).rejects.toThrow();
  });
  it("rejects wrong workspace and expired capabilities", async () => {
    const other = join(directory, "other"); await mkdir(other);
    const created = sessions.create("workspace_a", "browser_a", directory);
    await expect(sessions.bind(created.bootstrapKey, other, "window_a", "connection_a", socket())).rejects.toThrow();
    clock += BOOTSTRAP_TTL_MS + 1;
    await expect(sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", socket())).rejects.toThrow();
  });
  it("atomically accepts only one simultaneous claimant", async () => {
    const created = sessions.create("workspace_a", "browser_a", directory);
    const results = await Promise.allSettled([
      sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", socket()),
      sessions.bind(created.bootstrapKey, directory, "window_b", "connection_b", socket()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
  it("keeps dirty evidence across stale state and disconnection", async () => {
    const created = sessions.create("workspace_a", "browser_a", directory);
    const transport = socket();
    const session = await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", transport);
    sessions.update(session, 2, true); sessions.update(session, 1, false);
    expect(sessions.state(session)).toMatchObject({ known: true, dirty: true, sequence: 2 });
    sessions.disconnected(session, transport);
    expect(sessions.state(session)).toMatchObject({ known: false, dirty: true });
    await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", socket());
    expect(sessions.state(session).known).toBe(false);
    sessions.update(session, 3, false);
    expect(sessions.state(session)).toMatchObject({ known: true, dirty: false });
  });
  it("deduplicates file commands and rejects changed payloads with the same request ID", async () => {
    const created = sessions.create("workspace_a", "browser_a", directory);
    const transport = socket(); const written = vi.spyOn(transport, "write").mockReturnValue(true);
    const session = await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", transport);
    sessions.update(session, 1, false);
    const first = sessions.open(session, "request_a", { path: "/file:12:4", line: 3 });
    const duplicate = sessions.open(session, "request_a", { path: "/file:12:4", line: 3 });
    expect(written).toHaveBeenCalledTimes(1);
    await expect(sessions.open(session, "request_a", { path: "/different" })).rejects.toThrow();
    sessions.result(session, "stale_request", true);
    expect(session.pending.size).toBe(1);
    sessions.result(session, "request_a", true);
    await Promise.all([first, duplicate]);
    expect(session.pending.size).toBe(0);
  });
  it("destroys the bound transport when releasing the panel", async () => {
    const created = sessions.create("workspace_a", "browser_a", directory);
    const transport = socket();
    const session = await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", transport);
    sessions.release(session);
    expect(transport.destroyed).toBe(true);
    expect(() => sessions.authorize(created.sessionId, created.ownerKey)).toThrow();
  });
  it("bounds remembered requests even while the oldest command is still pending", async () => {
    const created = sessions.create("workspace_a", "browser_a", directory);
    const transport = socket(); vi.spyOn(transport, "write").mockReturnValue(true);
    const session = await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", transport);
    sessions.update(session, 1, false);
    const held = sessions.open(session, "request_held", { path: "/held" });
    for (let index = 0; index < 100; index++) {
      const id = `request_${index}`;
      const result = sessions.open(session, id, { path: "/file" });
      sessions.result(session, id, true); await result;
      expect(session.requests.size).toBeLessThanOrEqual(64);
    }
    expect(session.requests.has("request_held")).toBe(true);
    sessions.result(session, "request_held", true); await held;
  });
  it("requires a new companion round trip instead of returning a cached clean snapshot", async () => {
    const created = sessions.create("workspace_a", "browser_a", directory);
    const transport = socket(); const written = vi.spyOn(transport, "write").mockReturnValue(true);
    const session = await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", transport);
    sessions.update(session, 1, false);
    let resolved = false;
    const response = sessions.freshState(session).then((state) => { resolved = true; return state; });
    await Promise.resolve(); expect(resolved).toBe(false);
    const command = JSON.parse(String(written.mock.calls[0]![0]));
    expect(command.type).toBe("getState");
    sessions.snapshot(session, "unrelated_request", 2, false);
    await Promise.resolve(); expect(resolved).toBe(false);
    sessions.snapshot(session, command.requestId, 3, true);
    await expect(response).resolves.toMatchObject({ known: true, dirty: true, sequence: 3 });
  });
  it("rejects stale correlated snapshots instead of clearing dirty protection", async () => {
    const created = sessions.create("workspace_a", "browser_a", directory);
    const transport = socket(); const written = vi.spyOn(transport, "write").mockReturnValue(true);
    const session = await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", transport);
    sessions.update(session, 4, true);
    const response = sessions.freshState(session);
    const request = JSON.parse(String(written.mock.calls[0]![0]));
    sessions.snapshot(session, request.requestId, 3, false);
    await expect(response).rejects.toThrow("stale");
    expect(sessions.state(session).dirty).toBe(true);
  });
});
