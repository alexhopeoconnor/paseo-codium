import type { FileTarget } from "./wire";

/** Inputs have already passed the target validator; VS Code columns are UTF-16. */
export function cursorRange(target: FileTarget, lineCount: number, lineLength: (line: number) => number) {
  const startLine = Math.min(lineCount - 1, (target.line ?? 1) - 1);
  const startColumn = Math.min(lineLength(startLine), (target.column ?? 1) - 1);
  const endLine = target.lineEnd === undefined ? startLine : Math.min(lineCount - 1, target.lineEnd - 1);
  const endColumn = target.lineEnd === undefined ? startColumn : lineLength(endLine);
  return { startLine, startColumn, endLine, endColumn };
}
