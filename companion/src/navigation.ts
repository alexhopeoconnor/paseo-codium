import * as vscode from "vscode";
import type { FileTarget } from "../../shared/wire";
import { cursorRange } from "../../shared/positions";
export async function openFile(target: FileTarget, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) throw new Error("The editor session is no longer current.");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.path));
  if (!isCurrent()) throw new Error("The editor session changed while opening the file.");
  const range = cursorRange(target, document.lineCount, (index) => document.lineAt(index).text.length);
  await vscode.window.showTextDocument(document, {
    preview: false,
    selection: new vscode.Range(range.startLine, range.startColumn, range.endLine, range.endColumn),
  });
}
