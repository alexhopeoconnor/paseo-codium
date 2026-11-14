import * as vscode from "vscode";
import { validActiveFile } from "../../shared/wire";

/** Null means no revealable active local file, never an absolute or outside path. */
export function activeWorkspaceFile(workspace: string): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return null;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const root = workspace.replace(/\/+$/, "");
  if (!folder || folder.uri.fsPath.replace(/\/+$/, "") !== root) return null;
  const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
  // Keep literal backslashes on Unix filenames; only Windows needs separator normalization.
  const normalized = process.platform === "win32" ? relative.replace(/\\/g, "/") : relative;
  return validActiveFile(normalized) ? normalized : null;
}

export function isDirty(): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.isDirty)) ||
    vscode.workspace.textDocuments.some((document) => document.isDirty) ||
    vscode.workspace.notebookDocuments.some((document) => document.isDirty);
}
export function observeEditorState(listener: () => void): vscode.Disposable[] {
  return [
    vscode.window.tabGroups.onDidChangeTabs(listener),
    vscode.window.tabGroups.onDidChangeTabGroups(listener),
    vscode.window.onDidChangeActiveTextEditor(listener),
    vscode.workspace.onDidChangeTextDocument(listener),
    vscode.workspace.onDidSaveTextDocument(listener),
    vscode.workspace.onDidOpenTextDocument(listener),
    vscode.workspace.onDidCloseTextDocument(listener),
    vscode.workspace.onDidChangeNotebookDocument(listener),
    vscode.workspace.onDidSaveNotebookDocument(listener),
    vscode.workspace.onDidOpenNotebookDocument(listener),
    vscode.workspace.onDidCloseNotebookDocument(listener),
  ];
}
