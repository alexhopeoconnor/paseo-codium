import * as vscode from "vscode";
import type { FileTarget } from "../../shared/wire";
import { cursorRange } from "../../shared/positions";
export async function openFile(target: FileTarget): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.path));
  const range = cursorRange(target, document.lineCount, (index) => document.lineAt(index).text.length);
  await vscode.window.showTextDocument(document, {
    preview: false,
    selection: new vscode.Range(range.startLine, range.startColumn, range.endLine, range.endColumn),
  });
}
