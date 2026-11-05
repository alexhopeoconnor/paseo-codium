import * as vscode from "vscode";

export function isDirty(): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.isDirty)) ||
    vscode.workspace.textDocuments.some((document) => document.isDirty) ||
    vscode.workspace.notebookDocuments.some((document) => document.isDirty);
}
export function observeEditorState(listener: () => void): vscode.Disposable[] {
  return [
    vscode.window.tabGroups.onDidChangeTabs(listener),
    vscode.window.tabGroups.onDidChangeTabGroups(listener),
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
