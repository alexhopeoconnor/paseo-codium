import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Vscode from "vscode";
import type { BridgeClient } from "../companion/src/bridge-client";

const api = vi.hoisted(() => ({
  openTextDocument: vi.fn(), showTextDocument: vi.fn(), closeTab: vi.fn(),
  getWorkspaceFolder: vi.fn(), asRelativePath: vi.fn(),
  activeTextEditor: undefined as unknown,
}));
vi.mock("vscode", () => ({
  workspace: {
    openTextDocument: api.openTextDocument,
    getWorkspaceFolder: api.getWorkspaceFolder,
    asRelativePath: api.asRelativePath,
  },
  window: {
    showTextDocument: api.showTextDocument,
    get activeTextEditor() { return api.activeTextEditor; },
    tabGroups: { all: [], close: api.closeTab },
  },
  Uri: { file: (path: string) => ({ path }) },
  Range: class {},
  EventEmitter: class { event = () => {}; dispose() {} },
  FileSystemError: { Unavailable: (message: string) => new Error(message), FileNotFound: (message: string) => new Error(message) },
}));
import { openFile } from "../companion/src/navigation";
import { BootstrapProvider } from "../companion/src/bootstrap-provider";
import { activeWorkspaceFile } from "../companion/src/editor-state";

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); api.activeTextEditor = undefined; });

describe("active workspace file", () => {
  const workspace = "/worktree";
  beforeEach(() => {
    api.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: workspace } });
    api.asRelativePath.mockReturnValue("src/a.ts");
    api.activeTextEditor = { document: { uri: { scheme: "file", fsPath: `${workspace}/src/a.ts` } } };
  });
  it("returns a normalized workspace-relative local file for manual tab changes", () => {
    expect(activeWorkspaceFile(workspace)).toBe("src/a.ts");
    api.asRelativePath.mockReturnValue("src/nested/b.ts");
    expect(activeWorkspaceFile(workspace)).toBe("src/nested/b.ts");
  });
  it("returns null for no editor, non-file, outside workspace or unsafe relative paths", () => {
    api.activeTextEditor = undefined;
    expect(activeWorkspaceFile(workspace)).toBeNull();
    api.activeTextEditor = { document: { uri: { scheme: "untitled", fsPath: `${workspace}/a.ts` } } };
    expect(activeWorkspaceFile(workspace)).toBeNull();
    api.activeTextEditor = { document: { uri: { scheme: "file", fsPath: `${workspace}/a.ts` } } };
    api.getWorkspaceFolder.mockReturnValue(undefined);
    expect(activeWorkspaceFile(workspace)).toBeNull();
    api.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/other" } });
    expect(activeWorkspaceFile(workspace)).toBeNull();
    api.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: workspace } });
    for (const unsafe of ["../outside.ts", "/absolute.ts", "a/../b.ts", "a//b.ts", ""]) {
      api.asRelativePath.mockReturnValue(unsafe);
      expect(activeWorkspaceFile(workspace)).toBeNull();
    }
  });
});

describe("late editor operations after disposal", () => {
  it("does not show a document when its session is invalidated during the read", async () => {
    let complete!: (value: unknown) => void;
    api.openTextDocument.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    let current = true;
    const opening = openFile({ path: "/file" }, () => current);
    current = false;
    complete({ lineCount: 1, lineAt: () => ({ text: "file" }) });
    await expect(opening).rejects.toThrow("session changed");
    expect(api.showTextDocument).not.toHaveBeenCalled();
  });
  it("does not schedule bootstrap-tab cleanup after the provider has been disposed", async () => {
    vi.useFakeTimers();
    let paired!: () => void;
    const bridge = { pair: () => new Promise<void>((resolve) => { paired = resolve; }) } as unknown as BridgeClient;
    const provider = new BootstrapProvider(bridge);
    const uri = { scheme: "paseo-codium-session", authority: "pair", path: `/${"a".repeat(64)}/session.txt`, query: "", fragment: "" } as Vscode.Uri;
    const reading = provider.readFile(uri);
    provider.dispose(); paired();
    await expect(reading).rejects.toThrow("session has closed");
    expect(vi.getTimerCount()).toBe(0);
    expect(api.closeTab).not.toHaveBeenCalled();
  });
});
