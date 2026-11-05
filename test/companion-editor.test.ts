import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Vscode from "vscode";
import type { BridgeClient } from "../companion/src/bridge-client";

const api = vi.hoisted(() => ({ openTextDocument: vi.fn(), showTextDocument: vi.fn(), closeTab: vi.fn() }));
vi.mock("vscode", () => ({
  workspace: { openTextDocument: api.openTextDocument },
  window: { showTextDocument: api.showTextDocument, tabGroups: { all: [], close: api.closeTab } },
  Uri: { file: (path: string) => ({ path }) },
  Range: class {},
  EventEmitter: class { event = () => {}; dispose() {} },
  FileSystemError: { Unavailable: (message: string) => new Error(message), FileNotFound: (message: string) => new Error(message) },
}));
import { openFile } from "../companion/src/navigation";
import { BootstrapProvider } from "../companion/src/bootstrap-provider";

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

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
