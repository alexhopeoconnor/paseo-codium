import * as vscode from "vscode";
import { BOOTSTRAP_SCHEME } from "../../shared/wire";
import { BridgeClient } from "./bridge-client";
import { BootstrapProvider } from "./bootstrap-provider";
import { isDirty, observeEditorState } from "./editor-state";
import { openFile } from "./navigation";
import { createWindowIdentity } from "./identity";

export function activate(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length !== 1 || folders[0]!.uri.scheme !== "file") {
    throw new Error("The Paseo bridge requires one local host folder in this Codium window.");
  }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.text = "$(link) Paseo"; status.tooltip = "Connecting this editor to its Paseo panel"; status.show();
  const bridge = new BridgeClient({
    windowId: createWindowIdentity(),
    workspace: folders[0]!.uri.fsPath,
    dirty: isDirty,
    open: openFile,
    status(connected) { status.text = connected ? "$(link) Paseo" : "$(debug-disconnect) Paseo";
      status.tooltip = connected ? "Connected to this window's Paseo editor panel" : "Paseo is disconnected. Unsaved edits remain in this editor."; },
  });
  const provider = new BootstrapProvider(bridge);
  context.subscriptions.push(status, bridge, provider,
    vscode.workspace.registerFileSystemProvider(BOOTSTRAP_SCHEME, provider, { isCaseSensitive: true, isReadonly: true }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const current = vscode.workspace.workspaceFolders;
      if (!current || current.length !== 1 || current[0]!.uri.toString() !== folders[0]!.uri.toString()) {
        bridge.dispose(); status.text = "$(debug-disconnect) Paseo";
        status.tooltip = "The workspace changed. Reopen the intended workspace from Paseo to reconnect.";
      }
    }),
    ...observeEditorState(() => bridge.sendState()));
}
