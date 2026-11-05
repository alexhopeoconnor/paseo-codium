export const MAX_PREVIEW_BYTES = 512 * 1024;
export const MAX_MERMAID_PREVIEWS = 4;

export function richPreviewAllowed(text: string): boolean {
  let diagrams = 0;
  // Deliberately conservative: count plausible fenced headers even inside an
  // enclosing code example. Account for indentation, quotes and list prefixes.
  const header = /^[\t >]*(?:(?:[-+*]|\d+[.)])[\t >]+)*(?:`{3,}|~{3,})[\t ]*mermaid\b/i;
  for (const line of text.split(/\r?\n/)) {
    if (header.test(line) && ++diagrams > MAX_MERMAID_PREVIEWS) return false;
  }
  return true;
}

interface PreviewFile {
  readonly size: number;
  readText(): Promise<string>;
}

function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("The file size is unavailable. Retry when the host reconnects.");
  if (size > MAX_PREVIEW_BYTES) throw new Error("This file is larger than the 512 KiB preview limit. Open it in VSCodium to view it.");
}

export async function readPreviewText(file: PreviewFile): Promise<string> {
  checkSize(file.size);
  const text = await file.readText();
  checkSize(file.size);
  // Check returned contents too: the file can grow between stat and read. The
  // SDK has no ranged read, so this bounds rendering, not in-flight transfer.
  if (text.length > MAX_PREVIEW_BYTES) throw new Error("This file is larger than the 512 KiB preview limit. Open it in VSCodium to view it.");
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_PREVIEW_BYTES) throw new Error("This file is larger than the 512 KiB preview limit. Open it in VSCodium to view it.");
    if (point === 0) throw new Error("This file contains binary data. Open it in VSCodium to view it.");
  }
  return text;
}

/** Keep live metadata and watch events; only bound the host handle's text read. */
export function boundedPreviewFile<T extends PreviewFile & { watch: (...args: never[]) => unknown }>(file: T): T {
  return Object.create(file, {
    readText: { value: () => readPreviewText(file) },
    watch: { value: file.watch.bind(file) },
  }) as T;
}
