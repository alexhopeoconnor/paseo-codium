import { describe, expect, it } from "vitest";
import { EditorQueue, editorQueue, shouldProtectEditor } from "../client/editor-session";
import { makeBootstrapUrl } from "../client/web";

describe("client workspace routing", () => {
  it("keeps host/workspace queues distinct", () => {
    expect(editorQueue("host-a", "workspace-a")).toBe(editorQueue("host-a", "workspace-a"));
    expect(editorQueue("host-a", "workspace-a")).not.toBe(editorQueue("host-b", "workspace-a"));
    expect(editorQueue("host-a", "workspace-a")).not.toBe(editorQueue("host-a", "workspace-b"));
  });
  it("accepts only matching ordered acknowledgements and ignores duplicate enqueue", () => {
    const queue = new EditorQueue();
    queue.enqueue({ requestId: "request_a", target: { path: "/a" } });
    queue.enqueue({ requestId: "request_a", target: { path: "/a" } });
    queue.enqueue({ requestId: "request_b", target: { path: "/b" } });
    queue.complete("request_b", true);
    expect(queue.peek()?.requestId).toBe("request_a");
    queue.complete("request_a", true);
    expect(queue.lastTarget).toEqual({ path: "/a" });
    expect(queue.peek()?.requestId).toBe("request_b");
    queue.complete("request_b", false);
    expect(queue.peek()).toBeUndefined();
    expect(queue.lastTarget).toEqual({ path: "/a" });
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
    for (let index = 0; index < 32; index++) queue.enqueue({ requestId: `request_${index}`, target: { path: "/file" } });
    expect(() => queue.enqueue({ requestId: "overflow", target: { path: "/file" } })).toThrow();
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
