import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveFileTracker, EDITOR_POLL_HIDDEN_MS, EDITOR_POLL_VISIBLE_MS, EditorQueue, EditorReceipts, ReceiptInspection, clearEditorQueues, clearEditorReceipts, editorConnectionKey, editorPanelVisible, editorPollDelay, editorQueue, editorReceipts, forwardFileNavigation, PENDING_FILE_TTL_MS, resolveEditorCloseProtection, restoredEditorTarget, revealOpenedFile, shouldProtectEditor, shouldReleaseCreatedSession } from "../client/editor-session";
import { browserDocumentEpoch, makeBootstrapUrl, mountCodiumFrame, observePanelVisibility, panelHasVisibleBounds } from "../client/web";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createConfirmedFileOpener } from "../client/file-open";
import { closeProtectionSetter, createRevealLifetime, openPanelOptions, readHostCapabilities, revealPaseoFile, tabIsVisible, type ConfirmedFileOpenContext } from "../client/host-capabilities";
import { presentationPreferenceSchema } from "../shared/settings";
import { RECEIPT_TTL_MS } from "../shared/receipts";
import type { PluginTab } from "@getpaseo/plugin/client";

const connectionA = editorConnectionKey({ codiumBaseUrl: "https://a.example.com", openMode: "embedded" });
const connectionB = editorConnectionKey({ codiumBaseUrl: "https://b.example.com", openMode: "embedded" });
afterEach(() => { clearEditorQueues(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("confirmed host file opens", () => {
  function fixture() {
    const settings = { status: "ready" as const, revision: "1", values: { codiumBaseUrl: "https://a.example.com", openMode: "embedded" } };
    const rpc = vi.fn(async () => settings);
    const refresh = vi.fn(async () => ({ workspaceDirectory: "/worktree" }));
    const ref = vi.fn(() => ({ refresh }));
    const openPanel = vi.fn();
    const client = { rpc, paseo: { workspaces: { ref } }, openPanel } as unknown as PluginClientContext;
    const request: ConfirmedFileOpenContext = {
      requestId: "request_first", hostId: "host-a", workspaceId: "workspace-a", workspaceDirectory: "/worktree",
      path: "src/main.ts", lineStart: 4, lineEnd: 8, disposition: "preferred", platform: "web", signal: { aborted: false },
    };
    return { client, request, rpc, refresh, ref, openPanel, settings, open: createConfirmedFileOpener(client) };
  }
  it("opts into only understood host capability versions", () => {
    const { client } = fixture();
    expect(readHostCapabilities(client)).toEqual({});
    expect(readHostCapabilities({ ...client, capabilities: { confirmedFileOpen: 1, workspacePanelRetention: 1, workspacePanelCloseProtection: 1 } } as PluginClientContext))
      .toEqual({ confirmedFileOpen: 1, workspacePanelRetention: 1, workspacePanelCloseProtection: 1 });
    expect(readHostCapabilities({ ...client, capabilities: { confirmedFileOpen: 2, workspacePanelRetention: true, workspacePanelCloseProtection: 2 } } as PluginClientContext))
      .toEqual({ confirmedFileOpen: undefined, workspacePanelRetention: undefined, workspacePanelCloseProtection: undefined });
  });
  it("resolves settings and workspace, then focuses before sending the original request ID and range", async () => {
    const f = fixture(), queue = editorQueue(f.request.hostId, f.request.workspaceId);
    queue.subscribe(() => expect(f.openPanel).toHaveBeenCalledWith("codium", { workspaceId: "workspace-a" }));
    expect(f.rpc).not.toHaveBeenCalled();
    await expect(f.open(f.request)).resolves.toBe("handled");
    expect(f.rpc).toHaveBeenCalledWith(expect.objectContaining({ name: "settings.connection.read" }), {});
    expect(f.ref).toHaveBeenCalledWith("workspace-a");
    expect(queue.peek()).toMatchObject({ requestId: "request_first", connectionKey: connectionA, target: { path: "/worktree/src/main.ts", line: 4, lineEnd: 8 } });
    expect(editorQueue("host-b", "workspace-a").peek()).toBeUndefined();
  });
  it("rejects a conflicting target reuse for the same host request id before routing again", async () => {
    const f = fixture();
    await f.open(f.request);
    expect(() => f.open({ ...f.request, path: "src/other.ts" })).toThrow("reused for a different file");
    expect(f.openPanel).toHaveBeenCalledOnce();
    expect(editorQueue("host-a", "workspace-a").peek()?.target.path).toBe("/worktree/src/main.ts");
  });
  it("coalesces one intent through asynchronous resolution and completion but allows an intentional repeat", async () => {
    const f = fixture();
    const first = f.open(f.request);
    expect(f.open(f.request)).toBe(first);
    await first;
    editorQueue("host-a", "workspace-a").complete(f.request.requestId, connectionA, true);
    await f.open(f.request);
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.openPanel).toHaveBeenCalledOnce();
    await f.open({ ...f.request, requestId: "request_second", signal: { aborted: false } });
    expect(f.openPanel).toHaveBeenCalledTimes(2);
    expect(editorQueue("host-a", "workspace-a").peek()?.requestId).toBe("request_second");
  });
  it("keeps native, external and unconfigured opens on the rendered external-opening surface", async () => {
    const f = fixture();
    await expect(f.open({ ...f.request, platform: "ios" })).resolves.toBe("render");
    expect(f.rpc).not.toHaveBeenCalled();
    f.settings.values.openMode = "external";
    await expect(f.open({ ...f.request, signal: { aborted: false } })).resolves.toBe("render");
    f.settings.values.openMode = "embedded"; f.settings.values.codiumBaseUrl = "";
    await expect(f.open({ ...f.request, signal: { aborted: false } })).resolves.toBe("render");
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.openPanel).not.toHaveBeenCalled();
  });
  it("stops before work, after settings, and after workspace resolution when cancelled", async () => {
    const before = fixture();
    expect(() => before.open({ ...before.request, signal: { aborted: true } })).toThrow("cancelled");
    expect(before.rpc).not.toHaveBeenCalled();
    const settings = fixture(), settingsSignal = { aborted: false };
    settings.rpc.mockImplementation(async () => { settingsSignal.aborted = true; return settings.settings; });
    await expect(settings.open({ ...settings.request, signal: settingsSignal })).rejects.toMatchObject({ name: "AbortError" });
    expect(settings.refresh).not.toHaveBeenCalled();
    const workspace = fixture(), workspaceSignal = { aborted: false };
    workspace.refresh.mockImplementation(async () => { workspaceSignal.aborted = true; return { workspaceDirectory: "/worktree" }; });
    await expect(workspace.open({ ...workspace.request, signal: workspaceSignal })).rejects.toMatchObject({ name: "AbortError" });
    expect(workspace.openPanel).not.toHaveBeenCalled();
  });
  it("never reports an in-flight RPC as not sent when aborted or the connection changes", () => {
    const signal = { aborted: false }, queue = new EditorQueue();
    queue.enqueue({ connectionKey: connectionA, requestId: "request_inflight_abort", target: { path: "/a" }, signal });
    editorReceipts.advance("request_inflight_abort", "execution", "sent");
    signal.aborted = true;
    queue.takeExpiredNotice();
    expect(queue.peek()).toBeUndefined();
    expect(editorReceipts.get("request_inflight_abort")).toMatchObject({
      outcome: "uncertain", dispatched: true, reason: "cancelled",
    });

    const changed = new EditorQueue();
    changed.enqueue({ connectionKey: connectionA, requestId: "request_inflight_change", target: { path: "/b" } });
    editorReceipts.advance("request_inflight_change", "execution", "sent");
    changed.discardOtherConnections(connectionB);
    expect(changed.peek()).toBeUndefined();
    expect(editorReceipts.get("request_inflight_change")).toMatchObject({
      outcome: "uncertain", dispatched: true, reason: "connection_changed",
    });
  });
  it("drops a cancelled pending command without reporting expiration or reviving it", async () => {
    const f = fixture(), signal = { aborted: false };
    await f.open({ ...f.request, signal });
    signal.aborted = true;
    const queue = editorQueue("host-a", "workspace-a");
    expect(queue.peekForConnection(connectionA)).toBeUndefined();
    expect(queue.takeExpiredNotice()).toBe(false);
    expect(() => f.open({ ...f.request, signal })).toThrow("cancelled");
  });
  it("rejects a moved workspace or failed focus without dispatching another viewer or file", async () => {
    const moved = fixture();
    moved.refresh.mockResolvedValue({ workspaceDirectory: "/other-worktree" });
    await expect(moved.open(moved.request)).rejects.toThrow("directory changed");
    expect(moved.openPanel).not.toHaveBeenCalled();
    const f = fixture();
    f.openPanel.mockImplementation(() => { throw new Error("focus failed"); });
    await expect(f.open(f.request)).rejects.toThrow("focus failed");
    await expect(f.open(f.request)).rejects.toThrow("focus failed");
    expect(f.openPanel).toHaveBeenCalledOnce();
    expect(editorQueue("host-a", "workspace-a").peek()).toBeUndefined();
  });
  it("does not send a new connection's confirmed request through the existing old editor", async () => {
    const f = fixture(), queue = editorQueue("host-a", "workspace-a"), oldEditor = vi.fn();
    queue.subscribe(() => { if (queue.peekForConnection(connectionA)) oldEditor(); });
    f.settings.values.codiumBaseUrl = "https://b.example.com";
    await f.open(f.request);
    expect(oldEditor).not.toHaveBeenCalled();
    expect(queue.peekForConnection(connectionB)?.requestId).toBe(f.request.requestId);
  });
});

describe("client workspace routing", () => {
  it("keeps host/workspace queues distinct", () => {
    expect(editorQueue("host-a", "workspace-a")).toBe(editorQueue("host-a", "workspace-a"));
    expect(editorQueue("host-a", "workspace-a")).not.toBe(editorQueue("host-b", "workspace-a"));
    expect(editorQueue("host-a", "workspace-a")).not.toBe(editorQueue("host-a", "workspace-b"));
  });
  it("accepts only matching ordered acknowledgements and ignores duplicate enqueue", () => {
    const queue = new EditorQueue();
    queue.enqueue({ connectionKey: connectionA, requestId: "request_a", target: { path: "/a" } });
    queue.enqueue({ connectionKey: connectionA, requestId: "request_a", target: { path: "/a" } });
    queue.enqueue({ connectionKey: connectionA, requestId: "request_b", target: { path: "/b" } });
    queue.complete("request_b", connectionA, true);
    expect(queue.peek()?.requestId).toBe("request_a");
    queue.complete("request_a", connectionA, true);
    expect(queue.lastTargetFor(connectionA)).toEqual({ path: "/a" });
    expect(queue.peek()?.requestId).toBe("request_b");
    queue.complete("request_b", connectionA, false);
    expect(queue.peek()).toBeUndefined();
    expect(queue.lastTargetFor(connectionA)).toEqual({ path: "/a" });
  });
  it("bootstraps a virtual document without goto parsing", () => {
    const key = "a".repeat(64);
    const result = new URL(makeBootstrapUrl("https://codium.example.com", "/worktree feature", key));
    expect(result.searchParams.get("folder")).toBe("/worktree feature");
    expect(JSON.parse(result.searchParams.get("payload")!)).toEqual([["openFile", `paseo-codium-session://pair/${key}/session.txt`]]);
    expect(() => makeBootstrapUrl("https://codium.example.com", "/project", "bad")).toThrow();
  });
  it("bounds queued requests", () => {
    const queue = new EditorQueue();
    for (let index = 0; index < 32; index++) queue.enqueue({ connectionKey: connectionA, requestId: `request_${index}`, target: { path: "/file" } });
    expect(() => queue.enqueue({ connectionKey: connectionA, requestId: "overflow", target: { path: "/file" } })).toThrow();
  });
  it("does not notify a connected editor or queue a request when routing fails", () => {
    const queue = new EditorQueue();
    const listener = vi.fn(); queue.subscribe(listener);
    expect(() => queue.route({ connectionKey: connectionA, requestId: "failed_route", target: { path: "/failed" } }, () => { throw new Error("routing failed"); })).toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(queue.peek()).toBeUndefined();
  });
  it("checks capacity before focusing and only notifies after successful routing", () => {
    const queue = new EditorQueue(), focus = vi.fn();
    const listener = vi.fn(() => { expect(focus).toHaveBeenCalledOnce(); }); queue.subscribe(listener);
    queue.route({ connectionKey: connectionA, requestId: "request_first", target: { path: "/file" } }, focus);
    expect(listener).toHaveBeenCalledOnce();
    for (let index = 1; index < 32; index++) queue.enqueue({ connectionKey: connectionA, requestId: `request_${index}`, target: { path: "/file" } });
    expect(() => queue.route({ connectionKey: connectionA, requestId: "overflow", target: { path: "/file" } }, focus)).toThrow();
    expect(focus).toHaveBeenCalledOnce();
  });
  it("does not send a new connection's request through the still-open previous editor", () => {
    const queue = new EditorQueue(), oldEditorRequests: string[] = [];
    queue.subscribe(() => {
      const request = queue.peekForConnection(connectionA);
      if (request) oldEditorRequests.push(request.target.path);
    });
    queue.route({ connectionKey: connectionB, requestId: "new_connection", target: { path: "/new-file" } }, vi.fn());
    expect(oldEditorRequests).toEqual([]);
    expect(queue.peekForConnection(connectionB)?.target.path).toBe("/new-file");
    queue.complete("new_connection", connectionA, true);
    expect(queue.peekForConnection(connectionB)).toBeDefined();
    queue.complete("new_connection", connectionB, true);
    expect(queue.lastTargetFor(connectionA)).toBeUndefined();
    expect(queue.lastTargetFor(connectionB)).toEqual({ path: "/new-file" });
  });
  it("drops pending old-connection intents when a new connection request replaces them", () => {
    const queue = new EditorQueue();
    for (let index = 0; index < 32; index++) queue.enqueue({ connectionKey: connectionA, requestId: `old_${index}`, target: { path: "/old" } });
    queue.route({ connectionKey: connectionB, requestId: "new_connection", target: { path: "/new" } }, vi.fn());
    expect(queue.peekForConnection(connectionA)).toBeUndefined();
    expect(queue.peekForConnection(connectionB)?.target.path).toBe("/new");
    queue.complete("new_connection", connectionB, true);
    expect(queue.peek()).toBeUndefined();
  });
  it("preserves queued work if focusing the requested connection fails", () => {
    const queue = new EditorQueue();
    queue.enqueue({ connectionKey: connectionA, requestId: "old_connection", target: { path: "/old" } });
    expect(() => queue.route({ connectionKey: connectionB, requestId: "new_connection", target: { path: "/new" } }, () => { throw new Error("focus failed"); })).toThrow();
    expect(queue.peekForConnection(connectionA)?.target.path).toBe("/old");
    expect(queue.peekForConnection(connectionB)).toBeUndefined();
  });
  it("applying an external or different connection discards stale pending requests", () => {
    const queue = new EditorQueue();
    queue.enqueue({ connectionKey: connectionA, requestId: "old_connection", target: { path: "/old" } });
    const external = editorConnectionKey({ codiumBaseUrl: "https://a.example.com", openMode: "external" });
    expect(external).not.toBe(connectionA);
    queue.discardOtherConnections(external);
    expect(queue.peek()).toBeUndefined();
    queue.enqueue({ connectionKey: connectionB, requestId: "new_connection", target: { path: "/new" } });
    queue.discardOtherConnections(connectionB);
    expect(queue.peekForConnection(connectionB)?.target.path).toBe("/new");
  });
  it("restores only a validated target belonging to the current origin and mode", () => {
    const lastTarget = { path: "/worktree/file.ts", line: 4 };
    expect(restoredEditorTarget({ connectionKey: connectionA, lastTarget }, connectionA)).toEqual(lastTarget);
    expect(restoredEditorTarget({ connectionKey: connectionA, lastTarget }, connectionB)).toBeUndefined();
    expect(restoredEditorTarget({ lastTarget }, connectionA)).toBeUndefined();
    expect(restoredEditorTarget({ connectionKey: connectionA, lastTarget: { path: "relative" } }, connectionA)).toBeUndefined();
  });
  it("expires unacknowledged pending intents rather than reviving them after a long close", () => {
    let now = 1000;
    const queue = new EditorQueue(() => now);
    queue.enqueue({ connectionKey: connectionA, requestId: "old_pending", target: { path: "/old" } });
    now += PENDING_FILE_TTL_MS - 1;
    expect(queue.peek()).toBeDefined();
    now += 1;
    expect(queue.peek()).toBeUndefined();
    expect(queue.takeExpiredNotice()).toBe(true);
    expect(queue.takeExpiredNotice()).toBe(false);
    queue.complete("old_pending", connectionA, true);
    expect(queue.lastTargetFor(connectionA)).toBeUndefined();
  });
  it("keeps active workspace queues but removes expired idle queues", () => {
    vi.useFakeTimers();
    const idle = editorQueue("host", "idle"), active = editorQueue("host", "active");
    const unsubscribe = active.subscribe(vi.fn());
    vi.advanceTimersByTime(PENDING_FILE_TTL_MS);
    expect(editorQueue("host", "idle")).not.toBe(idle);
    expect(editorQueue("host", "active")).toBe(active);
    unsubscribe();
    vi.advanceTimersByTime(PENDING_FILE_TTL_MS);
    expect(editorQueue("host", "active")).not.toBe(active);
  });
  it("bounds the registry without evicting a pending request from an inactive workspace", () => {
    const protectedQueue = editorQueue("host", "pending");
    protectedQueue.enqueue({ connectionKey: connectionA, requestId: "pending_file", target: { path: "/pending" } });
    const disposable = editorQueue("host", "disposable");
    for (let index = 0; index < 130; index++) editorQueue("host", `workspace_${index}`);
    expect(editorQueue("host", "pending")).toBe(protectedQueue);
    expect(editorQueue("host", "disposable")).not.toBe(disposable);
  });
  it("protects immediate edits while the iframe has focus", () => {
    expect(shouldProtectEditor({ known: true, dirty: false }, true, 1, 1)).toBe(true);
  });
  it("requires a snapshot requested after focus exit before clearing protection", () => {
    expect(shouldProtectEditor({ known: true, dirty: false }, false, 1, 2)).toBe(true);
    expect(shouldProtectEditor({ known: true, dirty: false }, false, 2, 2)).toBe(false);
  });
  it("never clears protection on unknown or dirty evidence", () => {
    expect(shouldProtectEditor({ known: false, dirty: false }, false, 2, 2)).toBe(true);
    expect(shouldProtectEditor({ known: true, dirty: true }, false, 2, 2)).toBe(true);
  });
  it("does not mark a clean focused editor modified when the host checks fresh state before closing", () => {
    expect(shouldProtectEditor({ connected: true, known: true, dirty: false }, true, 1, 2, true)).toBe(false);
    expect(shouldProtectEditor({ connected: true, known: true, dirty: true }, true, 1, 2, true)).toBe(true);
    expect(shouldProtectEditor({ connected: true, known: false, dirty: false }, false, 2, 2, true)).toBe(true);
    expect(shouldProtectEditor({ connected: false, known: true, dirty: false }, false, 2, 2, true)).toBe(true);
  });
});

describe("fresh editor close protection", () => {
  const clean = { connected: true, known: true, dirty: false };
  it("uses only a capability-enabled host setter and keeps its stable ownership identity", () => {
    const setter = vi.fn(), tab = { setCloseProtectionResolver: setter } as unknown as PluginTab;
    expect(closeProtectionSetter(tab, true)).toBe(setter);
    expect(closeProtectionSetter(tab, false)).toBeUndefined();
    expect(closeProtectionSetter({} as PluginTab, true)).toBeUndefined();
  });
  it("reads again at close time and protects an edit made after the last clean poll", async () => {
    let current = clean;
    const read = vi.fn(async () => current), publish = vi.fn(() => false);
    await expect(resolveEditorCloseProtection(read, () => true, publish)).resolves.toBe(false);
    current = { ...clean, dirty: true };
    await expect(resolveEditorCloseProtection(read, () => true, publish)).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(current);
  });
  it("discards clean replies when the window is refocused or the editor session is replaced", async () => {
    let current = true;
    let answer!: (state: typeof clean) => void;
    const read = () => new Promise<typeof clean>((resolve) => { answer = resolve; });
    const publish = vi.fn(() => false);
    const result = resolveEditorCloseProtection(read, () => current, publish);
    current = false; answer(clean);
    await expect(result).resolves.toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });
  it("preserves newer dirty evidence and refuses unknown or disconnected snapshots", async () => {
    await expect(resolveEditorCloseProtection(async () => clean, () => true, () => true)).resolves.toBe(true);
    await expect(resolveEditorCloseProtection(async () => ({ ...clean, known: false }), () => true, () => false)).resolves.toBe(true);
    await expect(resolveEditorCloseProtection(async () => ({ ...clean, connected: false }), () => true, () => false)).resolves.toBe(true);
  });
  it("does not fabricate a clean result when the fresh paired-window request fails", async () => {
    const publish = vi.fn(() => false);
    await expect(resolveEditorCloseProtection(async () => { throw new Error("pairing disconnected"); }, () => true, publish)).rejects.toThrow("pairing disconnected");
    expect(publish).not.toHaveBeenCalled();
  });
  it("blurs only its own iframe before a close snapshot and removes its listeners on teardown", () => {
    const doc = { activeElement: null as unknown, createElement: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const frame = { style: {}, remove: vi.fn(), blur: vi.fn(() => { doc.activeElement = null; }) };
    doc.createElement.mockReturnValue(frame);
    const listeners = new Map<string, () => void>();
    const win = { addEventListener: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      removeEventListener: vi.fn((event: string) => listeners.delete(event)), setTimeout, clearTimeout };
    vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
    const focus = vi.fn(), appendChild = vi.fn();
    const mounted = mountCodiumFrame({ appendChild }, "https://codium.example.com/", focus);
    const foreign = { blur: vi.fn() }; doc.activeElement = foreign;
    expect(mounted.blurForClose()).toBe(true);
    expect(foreign.blur).not.toHaveBeenCalled(); expect(frame.blur).not.toHaveBeenCalled();
    doc.activeElement = frame;
    listeners.get("blur")!();
    expect(focus).toHaveBeenLastCalledWith(true);
    expect(mounted.blurForClose()).toBe(true);
    expect(frame.blur).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenLastCalledWith(false);
    doc.activeElement = frame; listeners.get("blur")!();
    expect(focus.mock.calls).toEqual([[true], [false], [true]]);
    frame.blur.mockImplementationOnce(() => {});
    expect(mounted.blurForClose()).toBe(false);
    mounted.remove();
    expect(frame.remove).toHaveBeenCalledOnce();
    expect(win.removeEventListener).toHaveBeenCalledTimes(2);
    expect(doc.removeEventListener).toHaveBeenCalledTimes(2);
  });
});

describe("automatic file-open intents", () => {
  function panel() {
    let state: Record<string, unknown> = { unrelated: { preserved: true } };
    const open = vi.fn();
    const writeState = (next: Record<string, unknown>) => { state = next; };
    const input = (overrides = {}) => ({ documentEpoch: 1000, revision: 1, targetKey: "host:workspace:/a:1",
      visible: true, enabled: true, state, writeState, open, ...overrides });
    return { input, open, state: () => state };
  }
  it("forwards a click once and preserves unrelated tab state", () => {
    const p = panel();
    expect(forwardFileNavigation(p.input())).toBe("queued");
    expect(forwardFileNavigation(p.input())).toBe("unchanged");
    expect(p.open).toHaveBeenCalledTimes(1);
    expect(p.state().unrelated).toEqual({ preserved: true });
  });
  it("claims before synchronous re-entry and does not duplicate StrictMode effects", () => {
    const p = panel(), original = p.input();
    original.open = vi.fn(() => { expect(forwardFileNavigation(original)).toBe("unchanged"); });
    expect(forwardFileNavigation(original)).toBe("queued");
    expect(forwardFileNavigation(original)).toBe("unchanged");
    expect(original.open).toHaveBeenCalledTimes(1);
  });
  it("opens the identical file again when the host receives a new open revision", () => {
    const p = panel();
    forwardFileNavigation(p.input());
    expect(forwardFileNavigation(p.input({ revision: 2 }))).toBe("queued");
    expect(p.open).toHaveBeenCalledTimes(2);
  });
  it("does not replay a remounted tab or plugin reload with a fresh callback", () => {
    const p = panel();
    forwardFileNavigation(p.input());
    const persisted = JSON.parse(JSON.stringify(p.state()));
    expect(forwardFileNavigation(p.input({ state: persisted, writeState: vi.fn() }))).toBe("unchanged");
    expect(p.open).toHaveBeenCalledTimes(1);
  });
  it("recognizes handled stamps from the older sent-outcome release without replaying", () => {
    const p = panel();
    const oldState = { codiumFileNavigation: { documentEpoch: 1000, revision: 1, targetKey: "host:workspace:/a:1", outcome: "sent" } };
    expect(forwardFileNavigation(p.input({ state: oldState }))).toBe("unchanged");
    expect(p.open).not.toHaveBeenCalled();
  });
  it("skips revision-zero browser restoration but accepts the first new click", () => {
    const p = panel();
    forwardFileNavigation(p.input());
    expect(forwardFileNavigation(p.input({ documentEpoch: 2000, revision: 0 }))).toBe("unchanged");
    expect(forwardFileNavigation(p.input({ documentEpoch: 2000, revision: 1 }))).toBe("queued");
    expect(p.open).toHaveBeenCalledTimes(2);
  });
  it("waits while a background panel is hidden and claims only when visible", () => {
    const p = panel();
    expect(forwardFileNavigation(p.input({ visible: false }))).toBe("unchanged");
    expect(p.state()).not.toHaveProperty("codiumFileNavigation");
    expect(forwardFileNavigation(p.input())).toBe("queued");
    expect(forwardFileNavigation(p.input({ visible: false }))).toBe("unchanged");
    expect(forwardFileNavigation(p.input())).toBe("unchanged");
    expect(p.open).toHaveBeenCalledTimes(1);
  });
  it("handles a different target in the same panel slot", () => {
    const p = panel();
    forwardFileNavigation(p.input());
    expect(forwardFileNavigation(p.input({ targetKey: "host:workspace:/b:4" }))).toBe("queued");
    expect(p.open).toHaveBeenCalledTimes(2);
  });
  it("consumes external or unconfigured intent so enabling embedding later cannot replay it", () => {
    const p = panel();
    expect(forwardFileNavigation(p.input({ enabled: false, visible: false }))).toBe("skipped");
    expect(forwardFileNavigation(p.input())).toBe("unchanged");
    expect(p.open).not.toHaveBeenCalled();
    expect(forwardFileNavigation(p.input({ revision: 2 }))).toBe("queued");
  });
  it("records queue or routing failure without claiming success or automatically retrying", () => {
    const p = panel();
    p.open.mockImplementation(() => { throw new Error("queue full"); });
    expect(forwardFileNavigation(p.input())).toBe("failed");
    expect(p.state().codiumFileNavigation).toMatchObject({ outcome: "failed" });
    expect(forwardFileNavigation(p.input())).toBe("unchanged");
    p.open.mockImplementation(() => {});
    expect(forwardFileNavigation(p.input({ revision: 2 }))).toBe("queued");
  });
  it("does not dispatch if persisting the claim fails", () => {
    const p = panel();
    const input = p.input({ writeState: () => { throw new Error("state unavailable"); } });
    expect(forwardFileNavigation(input)).toBe("failed");
    expect(forwardFileNavigation(input)).toBe("unchanged");
    expect(p.open).not.toHaveBeenCalled();
  });
});

describe("file-open receipt memory", () => {
  afterEach(() => clearEditorReceipts());
  it("advances diagnostic stages monotonically through route, probe, pairing, bridge, queue and ack", () => {
    const receipts = new EditorReceipts();
    expect(receipts.begin("request_stage")).toMatchObject({ stage: "host_route", outcome: "pending", dispatched: false });
    receipts.advance("request_stage", "access_probe");
    receipts.advance("request_stage", "pairing");
    receipts.advance("request_stage", "bridge");
    receipts.advance("request_stage", "queue", "queued");
    receipts.merge("request_stage", {
      version: 2, correlationId: "request_stage", requestId: "request_stage", stage: "execution",
      outcome: "sent", dispatched: true, updatedAt: 10, expiresAt: 20,
    });
    const opened = receipts.advance("request_stage", "ack", "opened");
    expect(opened).toMatchObject({ stage: "ack", outcome: "opened", dispatched: true });
    // A terminal outcome never regresses because a stale diagnostic arrives later.
    expect(receipts.advance("request_stage", "queue", "queued")).toMatchObject({ stage: "ack", outcome: "opened" });
    expect(receipts.merge("request_stage", {
      version: 2, correlationId: "request_stage", requestId: "request_stage", stage: "queue",
      outcome: "queued", dispatched: false, updatedAt: 30, expiresAt: 40,
    })).toMatchObject({ stage: "ack", outcome: "opened" });
  });
  it("treats a null or expired server receipt as unknown, never not_sent", () => {
    const receipts = new EditorReceipts();
    receipts.begin("request_unknown");
    receipts.advance("request_unknown", "queue", "queued");
    expect(receipts.merge("request_unknown", null)).toMatchObject({ outcome: "queued" });
    expect(receipts.get("request_never_seen")).toBeUndefined();
  });
  it("prunes expired terminal receipts before begin/retry so they are not returned as retained", () => {
    let now = 1000;
    const receipts = new EditorReceipts(() => now);
    receipts.begin("request_expired");
    receipts.advance("request_expired", "ack", "opened");
    now += RECEIPT_TTL_MS + 1;
    // begin must not return the expired opened receipt.
    expect(receipts.begin("request_expired")).toMatchObject({ outcome: "pending", stage: "host_route" });
    now += RECEIPT_TTL_MS + 1;
    receipts.advance("request_expired", "ack", "opened");
    now += RECEIPT_TTL_MS + 1;
    // retry also treats expired memory as UNKNOWN and starts a fresh pending state.
    expect(receipts.retry("request_expired")).toMatchObject({ outcome: "pending", stage: "host_route" });
  });
  it("guards Check outcome against a slow receipt for a replaced request and out-of-order repeats", () => {
    const inspection = new ReceiptInspection();
    inspection.show("request_a");
    const firstA = inspection.begin()!;
    inspection.show("request_b");
    expect(inspection.accepts(firstA)).toBe(false);
    const firstB = inspection.begin()!;
    expect(inspection.accepts(firstB)).toBe(true);
    // A repeated check invalidates the earlier in-flight query for the same request.
    const secondB = inspection.begin()!;
    expect(inspection.accepts(firstB)).toBe(false);
    expect(inspection.accepts(secondB)).toBe(true);
    inspection.show("request_b");
    expect(inspection.accepts(secondB)).toBe(false);
    inspection.clear();
    expect(inspection.begin()).toBeUndefined();
  });
  it("expires only terminal receipts and keeps a pending request queryable", () => {
    let now = 1000;
    const receipts = new EditorReceipts(() => now);
    receipts.begin("request_pending");
    now += RECEIPT_TTL_MS + 1;
    expect(receipts.get("request_pending")).toMatchObject({ outcome: "pending" });
    receipts.advance("request_pending", "execution", "uncertain", "timeout");
    expect(receipts.get("request_pending")).toMatchObject({ outcome: "uncertain" });
    now += RECEIPT_TTL_MS + 1;
    expect(receipts.get("request_pending")).toBeUndefined();
  });
  it("keeps client memory bounded and never evicts a pending identity", () => {
    let now = 1000;
    const receipts = new EditorReceipts(() => now);
    for (let index = 0; index < 130; index++) {
      receipts.begin(`request_${index}`);
      receipts.advance(`request_${index}`, "ack", "opened");
      now += 1;
    }
    expect(receipts.get("request_0")).toBeUndefined();
    expect(receipts.get("request_129")).toMatchObject({ outcome: "opened" });
  });
  it("retains non-expired uncertain outcomes and reports explicit capacity instead of untracked admission", () => {
    const receipts = new EditorReceipts();
    for (let index = 0; index < 128; index++) {
      receipts.begin(`request_uncertain_${index}`);
      receipts.advance(`request_uncertain_${index}`, "execution", "uncertain", "timeout");
    }
    const next = receipts.begin("request_over_capacity");
    expect(next).toMatchObject({ outcome: "not_sent", reason: "capacity", dispatched: false });
    expect(receipts.get("request_uncertain_0")).toMatchObject({ outcome: "uncertain" });
    expect(receipts.get("request_over_capacity")).toBeUndefined();
  });
  it("reveals after a delayed open ACK as a fresh panel-scoped navigation, not a settled host request", () => {
    const reveal = vi.fn(), queue = new EditorQueue();
    queue.enqueue({ connectionKey: connectionA, requestId: "request_delayed", target: { path: "/worktree/src/main.ts" } });
    // The host onOpen handler has already returned handled after queue admission;
    // the editor then reconnects and acknowledges later.
    queue.complete("request_delayed", connectionA, "opened");
    expect(revealOpenedFile({ reveal, directory: "/worktree", path: "/worktree/src/main.ts" })).toBe(true);
    expect(reveal.mock.calls).toEqual([["src/main.ts"]]);
    expect(editorReceipts.get("request_delayed")).toMatchObject({
      correlationId: "request_delayed", outcome: "opened",
    });
  });
  it("does not reveal after the workspace panel is disposed while the open is waiting", () => {
    const reveal = vi.fn();
    expect(revealOpenedFile({ reveal, directory: "/worktree", path: "/worktree/a.ts", isCurrent: () => false })).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
  });
  it("does not admit a queue request when every tracking slot is an uncertain outcome", () => {
    for (let index = 0; index < 128; index++) {
      editorReceipts.begin(`request_uncertain_${index}`);
      editorReceipts.advance(`request_uncertain_${index}`, "execution", "uncertain", "timeout");
    }
    const queue = new EditorQueue();
    expect(() => queue.enqueue({ connectionKey: connectionA, requestId: "request_untracked", target: { path: "/file" } })).toThrow("tracked file requests");
    expect(queue.peek()).toBeUndefined();
    expect(editorReceipts.get("request_untracked")).toBeUndefined();
  });
});

describe("poll and session ownership guards", () => {
  it("requires both host tab visibility and document visibility for the fast poll", () => {
    expect(editorPanelVisible(true, true, true)).toBe(true);
    expect(editorPanelVisible(true, true, false)).toBe(false); // hidden browser
    expect(editorPanelVisible(false, true, true)).toBe(false); // hidden host tab
    expect(editorPanelVisible(undefined, true, false)).toBe(false);
    expect(editorPanelVisible(undefined, true, true)).toBe(true);
  });
  it("releases a created session superseded by a deferred overlapping retry", () => {
    expect(shouldReleaseCreatedSession({ disposed: false, attempt: 1, currentAttempt: 2, hasSession: false })).toBe(true);
    expect(shouldReleaseCreatedSession({ disposed: true, attempt: 1, currentAttempt: 1, hasSession: false })).toBe(true);
    expect(shouldReleaseCreatedSession({ disposed: false, attempt: 1, currentAttempt: 1, hasSession: true })).toBe(true);
    expect(shouldReleaseCreatedSession({ disposed: false, attempt: 1, currentAttempt: 1, hasSession: false })).toBe(false);
  });
});

describe("active file observation", () => {
  it("prevents an old cached file from overriding a confirmed target and reveals only actual changes", () => {
    const tracker = new ActiveFileTracker();
    const pollEpoch = tracker.epoch;
    tracker.confirm("src/new.ts", 10);
    // A cached poll that started before the ACK cannot apply afterwards.
    expect(tracker.observe("src/old.ts", 11, pollEpoch)).toMatchObject({ changed: false });
    expect(tracker.observe("src/old.ts", 10)).toMatchObject({ changed: false });
    expect(tracker.current).toBe("src/new.ts");
    expect(tracker.observe("src/new.ts", 11)).toMatchObject({ changed: false });
    expect(tracker.observe("src/old.ts", 12)).toMatchObject({ changed: true, reveal: "src/old.ts" });
    expect(tracker.observe("src/old.ts", 13)).toMatchObject({ changed: false });
    expect(tracker.observe(null, 14)).toMatchObject({ changed: true, activeFile: null });
    expect(tracker.observe(undefined, 15)).toMatchObject({ changed: false });
    expect(tracker.current).toBeNull();
  });
  it("fences an ahead cached poll with a fresh snapshot boundary after the open ACK", () => {
    const tracker = new ActiveFileTracker();
    tracker.observe("src/a.ts", 2);
    tracker.confirm("src/b.ts", 2);
    const fresh = tracker.beginFresh();
    // Poll started after the ACK can still return server-cached seq 4 / file A.
    expect(tracker.observe("src/a.ts", 4)).toMatchObject({ changed: false });
    expect(tracker.current).toBe("src/b.ts");
    expect(tracker.resolveFresh("src/b.ts", 5, fresh)).toMatchObject({ changed: false });
    // The real boundary is now 5; the old seq-4 cached file cannot replace B.
    expect(tracker.observe("src/a.ts", 4)).toMatchObject({ changed: false });
    expect(tracker.current).toBe("src/b.ts");
    expect(tracker.observe("src/c.ts", 6)).toMatchObject({ changed: true, reveal: "src/c.ts" });
  });
  it("keeps the confirmed target and blocks stale polls if the fresh boundary fails", () => {
    const tracker = new ActiveFileTracker();
    tracker.confirm("src/b.ts", 2);
    const fresh = tracker.beginFresh();
    tracker.failFresh(fresh);
    expect(tracker.observe("src/a.ts", 100)).toMatchObject({ changed: false });
    expect(tracker.current).toBe("src/b.ts");
    // A superseded snapshot token cannot resolve after a newer confirmation.
    const stale = tracker.beginFresh();
    tracker.confirm("src/c.ts", 3);
    expect(tracker.resolveFresh("src/a.ts", 101, stale)).toBeUndefined();
    expect(tracker.current).toBe("src/c.ts");
  });
  it("resynchronizes once after a failed boundary, then applies a manual C change", () => {
    const tracker = new ActiveFileTracker();
    tracker.confirm("src/b.ts", 2);
    tracker.failFresh(tracker.beginFresh());
    expect(tracker.needsResync).toBe(true);
    // The normal poll/refresh retry begins one fresh query and suspends polls.
    const retry = tracker.beginFresh();
    expect(tracker.awaitingFresh).toBe(true);
    expect(tracker.observe("src/c.ts", 100)).toMatchObject({ changed: false });
    expect(tracker.resolveFresh("src/b.ts", 101, retry)).toMatchObject({ changed: false });
    expect(tracker.needsResync).toBe(false);
    // Recovery is proven; a later manual C state is applied and revealed once.
    expect(tracker.observe("src/c.ts", 102)).toMatchObject({ changed: true, reveal: "src/c.ts" });
    expect(tracker.observe("src/c.ts", 103)).toMatchObject({ changed: false });
  });
  it("handles rapid state changes without a repeated reveal for the same file", () => {
    const tracker = new ActiveFileTracker();
    const observed = ["src/a.ts", "src/b.ts", "src/b.ts", "src/c.ts", null, null];
    const changes = observed.map((file, index) => tracker.observe(file, index + 1));
    expect(changes.map((change) => change.changed)).toEqual([true, true, false, true, true, false]);
    expect(changes.filter((change) => change.reveal).map((change) => change.reveal)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
});

describe("approved host capability adapter", () => {
  const client = {} as PluginClientContext;
  it("reads only version 1 capability names it understands", () => {
    expect(readHostCapabilities({ ...client, capabilities: {
      confirmedFileOpen: 1, workspacePanelRetention: 1, workspacePanelCloseProtection: 1,
      requestBoundPanelPlacement: 1, workspacePanelVisibility: 1, fileReveal: 1, textFilePanels: 1,
    } } as PluginClientContext)).toEqual({
      confirmedFileOpen: 1, workspacePanelRetention: 1, workspacePanelCloseProtection: 1,
      requestBoundPanelPlacement: 1, workspacePanelVisibility: 1, fileReveal: 1, textFilePanels: 1,
    });
    expect(readHostCapabilities({ ...client, capabilities: {
      requestBoundPanelPlacement: 2, workspacePanelVisibility: true, fileReveal: 1, textFilePanels: 2,
    } } as PluginClientContext)).toMatchObject({ requestBoundPanelPlacement: undefined, workspacePanelVisibility: undefined, textFilePanels: undefined });
  });
  it("sends the original request id only to a request-bound host", () => {
    expect(openPanelOptions({}, "workspace-a", "request_1234")).toEqual({ workspaceId: "workspace-a" });
    expect(openPanelOptions({ requestBoundPanelPlacement: 1 }, "workspace-a")).toEqual({ workspaceId: "workspace-a" });
    expect(openPanelOptions({ requestBoundPanelPlacement: 1 }, "workspace-a", "request_1234"))
      .toEqual({ workspaceId: "workspace-a", requestId: "request_1234" });
  });
  it("uses actual tab visibility only from a capable host", () => {
    const tab = { visible: true } as unknown as PluginTab;
    expect(tabIsVisible(tab, {})).toBeUndefined();
    expect(tabIsVisible(tab, { workspacePanelVisibility: 1 })).toBe(true);
    expect(tabIsVisible({ visible: false } as unknown as PluginTab, { workspacePanelVisibility: 1 })).toBe(false);
    expect(tabIsVisible({} as PluginTab, { workspacePanelVisibility: 1 })).toBeUndefined();
  });
  it("invokes the optional Paseo-tree reveal API only for a capable host and never opens an editor", async () => {
    const input = { workspaceId: "workspace-a", path: "src/main.ts", source: "editor" as const, intent: "auto" as const };
    const revealFile = vi.fn(async (): Promise<unknown> => ({ status: "revealed" }));
    const capable = { revealFile } as unknown as PluginClientContext;
    expect(await revealPaseoFile(capable, {}, input)).toBe("unsupported");
    expect(revealFile).not.toHaveBeenCalled();
    expect(await revealPaseoFile(capable, { fileReveal: 1 }, input)).toBe("revealed");
    expect(revealFile).toHaveBeenCalledWith(input, undefined);
    revealFile.mockResolvedValueOnce({ status: "cancelled" });
    expect(await revealPaseoFile(capable, { fileReveal: 1 }, input)).toBe("cancelled");
    revealFile.mockResolvedValueOnce({ status: "unavailable", reason: "hidden" });
    expect(await revealPaseoFile(capable, { fileReveal: 1 }, input)).toBe("unavailable");
    revealFile.mockRejectedValueOnce(new Error("cancelled"));
    expect(await revealPaseoFile(capable, { fileReveal: 1 }, input)).toBe("unavailable");
  });
  it("aborts a panel-scoped reveal signal after invocation and before the host listing/ACK", async () => {
    const lifetime = createRevealLifetime();
    const input = { workspaceId: "workspace-a", path: "src/main.ts", source: "editor" as const, intent: "explicit" as const };
    let observed: { readonly aborted: boolean } | undefined;
    let finish!: (result: unknown) => void;
    const hostResult = new Promise((resolve) => { finish = resolve; });
    const revealFile = vi.fn((_input, options) => { observed = options?.signal; return hostResult; });
    const capable = { revealFile } as unknown as PluginClientContext;
    const pending = revealPaseoFile(capable, { fileReveal: 1 }, input, { signal: lifetime.signal });
    await Promise.resolve();
    expect(observed).toBe(lifetime.signal);
    expect(observed?.aborted).toBe(false);
    lifetime.abort();
    expect(observed?.aborted).toBe(true);
    finish({ status: "revealed" });
    await expect(pending).resolves.toBe("revealed");
    expect(revealFile).toHaveBeenCalledWith(input, { signal: lifetime.signal });
  });
  it("uses 2s visible and 15s hidden display polling; close snapshots do not use this cache", () => {
    expect(editorPollDelay(true)).toBe(2_000);
    expect(editorPollDelay(false)).toBe(15_000);
    expect(EDITOR_POLL_VISIBLE_MS).toBe(2_000);
    expect(EDITOR_POLL_HIDDEN_MS).toBe(15_000);
  });
});

describe("Codium presentation preference", () => {
  it("defaults to closing the Codium sidebar once and is not part of connection identity", () => {
    expect(presentationPreferenceSchema.parse({})).toEqual({ closePrimarySidebar: true });
    const connection = { codiumBaseUrl: "https://a.example.com", openMode: "embedded" as const };
    expect(editorConnectionKey(connection)).toBe(editorConnectionKey({ ...connection }));
    expect(editorConnectionKey(connection)).not.toContain("closePrimarySidebar");
  });
});

describe("browser file-panel visibility", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("uses a document epoch that is stable across plugin module reloads", () => {
    vi.stubGlobal("performance", { timeOrigin: 123456 });
    expect(browserDocumentEpoch()).toBe(123456);
  });
  it("does not reveal hidden, detached or background-browser panels and disconnects observation", () => {
    let callback: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const disconnect = vi.fn(), observe = vi.fn(), listeners = new Map<string, () => void>();
    const doc = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type) };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("IntersectionObserver", class {
      constructor(listener: typeof callback) { callback = listener; }
      observe = observe; disconnect = disconnect;
    });
    const bounds = { width: 800, height: 600 };
    const node = { isConnected: true, getBoundingClientRect: () => bounds };
    const changed = vi.fn(), stop = observePanelVisibility(node, changed);
    callback([{ isIntersecting: false }]); expect(changed).toHaveBeenLastCalledWith(false);
    callback([{ isIntersecting: true }]); expect(changed).toHaveBeenLastCalledWith(true);
    bounds.width = 0;
    // The dispatch guard sees hiding immediately, before the observer catches up.
    expect(panelHasVisibleBounds(node)).toBe(false);
    callback([{ isIntersecting: true }]); expect(changed).toHaveBeenLastCalledWith(false);
    bounds.width = 800; node.isConnected = false; callback([{ isIntersecting: true }]); expect(changed).toHaveBeenLastCalledWith(false);
    node.isConnected = true; doc.visibilityState = "hidden"; listeners.get("visibilitychange")!(); expect(changed).toHaveBeenLastCalledWith(false);
    doc.visibilityState = "visible"; listeners.get("visibilitychange")!(); expect(changed).toHaveBeenLastCalledWith(true);
    stop(); expect(disconnect).toHaveBeenCalledOnce(); expect(listeners.size).toBe(0);
  });
});
