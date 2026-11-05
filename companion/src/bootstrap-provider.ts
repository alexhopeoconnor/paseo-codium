import * as vscode from "vscode";
import type { BridgeClient } from "./bridge-client";
import { BOOTSTRAP_SCHEME } from "../../shared/wire";

export class BootstrapProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly content = new TextEncoder().encode("Connected to Paseo. This temporary document can be closed.\n");
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  constructor(private readonly bridge: BridgeClient) {}
  private key(uri: vscode.Uri) {
    const match = /^\/([a-f0-9]{64})\/session\.txt$/.exec(uri.path);
    if (uri.scheme !== BOOTSTRAP_SCHEME || uri.authority !== "pair" || uri.query || uri.fragment || !match) throw vscode.FileSystemError.FileNotFound("Invalid Paseo pairing document.");
    return match[1]!;
  }
  stat(uri: vscode.Uri): vscode.FileStat {
    this.key(uri); return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.content.length, permissions: vscode.FilePermission.Readonly };
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (this.disposed) throw vscode.FileSystemError.Unavailable("The Paseo editor session has closed.");
    try { await this.bridge.pair(this.key(uri)); }
    catch { throw vscode.FileSystemError.Unavailable("Paseo pairing is unavailable or expired. Reconnect from the intended Paseo panel."); }
    if (this.disposed) throw vscode.FileSystemError.Unavailable("The Paseo editor session has closed.");
    this.closeBootstrap(uri, 0);
    return this.content;
  }
  private closeBootstrap(uri: vscode.Uri, attempt: number) {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      const tab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((candidate) =>
        candidate.input instanceof vscode.TabInputText && candidate.input.uri.toString() === uri.toString());
      if (tab && !tab.isDirty) void vscode.window.tabGroups.close(tab, true).then(undefined, () => {});
      else if (attempt < 5) this.closeBootstrap(uri, attempt + 1);
    }, 250);
    this.timers.add(timer);
  }
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  readDirectory(): [string, vscode.FileType][] { throw vscode.FileSystemError.NoPermissions(); }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }
  dispose() { this.disposed = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); this.changes.dispose(); }
}
