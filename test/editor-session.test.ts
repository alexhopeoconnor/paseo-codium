import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorQueue, clearEditorQueues, editorConnectionKey, editorQueue, forwardFileNavigation, PENDING_FILE_TTL_MS, restoredEditorTarget, shouldProtectEditor } from "../client/editor-session";
import { browserDocumentEpoch, makeBootstrapUrl, observePanelVisibility, panelHasVisibleBounds } from "../client/web";

const connectionA = editorConnectionKey({ codiumBaseUrl: "https://a.example.com", openMode: "embedded" });
const connectionB = editorConnectionKey({ codiumBaseUrl: "https://b.example.com", openMode: "embedded" });
afterEach(() => { clearEditorQueues(); vi.useRealTimers(); });

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
