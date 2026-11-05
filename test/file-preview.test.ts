import { describe, expect, it, vi } from "vitest";
import { boundedPreviewFile, MAX_PREVIEW_BYTES, readPreviewText, richPreviewAllowed } from "../client/file-preview-text";

describe("read-only file preview bounds", () => {
  it.each([MAX_PREVIEW_BYTES + 1, Infinity, NaN, -1, 1.5])("does not read files with oversized or invalid metadata: %s", async (size) => {
    const readText = vi.fn(async () => "text");
    await expect(readPreviewText({ size, readText })).rejects.toThrow();
    expect(readText).not.toHaveBeenCalled();
  });
  it("accepts empty files and preserves literal source including HTML without interpreting it", async () => {
    await expect(readPreviewText({ size: 0, readText: async () => "" })).resolves.toBe("");
    const text = '<script>throw new Error("do not execute")</script>\n  <svg onload="unexpected()" />';
    await expect(readPreviewText({ size: text.length, readText: async () => text })).resolves.toBe(text);
  });
  it("rejects growth detected after an outstanding read", async () => {
    const file = { size: 1, readText: async () => { file.size = MAX_PREVIEW_BYTES + 1; return "x"; } };
    await expect(readPreviewText(file)).rejects.toThrow("512 KiB");
  });
  it("checks returned UTF-8 bytes even when metadata is stale", async () => {
    const text = "💡".repeat(MAX_PREVIEW_BYTES / 4 + 1);
    expect(text.length).toBeLessThan(MAX_PREVIEW_BYTES);
    await expect(readPreviewText({ size: 1, readText: async () => text })).rejects.toThrow("512 KiB");
    const boundary = "💡".repeat(MAX_PREVIEW_BYTES / 4);
    await expect(readPreviewText({ size: MAX_PREVIEW_BYTES, readText: async () => boundary })).resolves.toBe(boundary);
  });
  it("rejects binary NUL data and preserves read/deletion errors for the preview", async () => {
    await expect(readPreviewText({ size: 3, readText: async () => "a\0b" })).rejects.toThrow("binary data");
    const deleted = new Error("The file was deleted.");
    await expect(readPreviewText({ size: 1, readText: async () => { throw deleted; } })).rejects.toBe(deleted);
  });
  it("keeps live metadata, disk-change events and unsubscribe without invoking writes", async () => {
    let size = 3;
    let listener: ((event: { type: "changed" | "deleted" }) => void) | undefined;
    const unwatch = vi.fn(), writeText = vi.fn(), readText = vi.fn(async () => "one");
    const file = { get size() { return size; }, readText, writeText,
      watch(callback: NonNullable<typeof listener>) { expect(this).toBe(file); listener = callback; return unwatch; } };
    const bounded = boundedPreviewFile(file), changed = vi.fn();
    const stop = bounded.watch(changed);
    await expect(bounded.readText()).resolves.toBe("one");
    size = MAX_PREVIEW_BYTES + 1;
    listener!({ type: "changed" });
    expect(changed).toHaveBeenCalledWith({ type: "changed" });
    await expect(bounded.readText()).rejects.toThrow("512 KiB");
    expect(readText).toHaveBeenCalledOnce();
    listener!({ type: "deleted" });
    expect(changed).toHaveBeenLastCalledWith({ type: "deleted" });
    stop(); expect(unwatch).toHaveBeenCalledOnce(); expect(writeText).not.toHaveBeenCalled();
  });
});

describe("Markdown diagram preview limits", () => {
  it("allows ordinary Markdown and up to four diagrams", () => {
    expect(richPreviewAllowed("# Heading\n\nA normal document.")).toBe(true);
    expect(richPreviewAllowed("```mermaid\ngraph TD; A --> B\n```\n".repeat(4))).toBe(true);
  });
  it.each(["```mermaid", "~~~~Mermaid", "   ``` MERMAID", "> > ```mermaid", "  - > ~~~mermaid"])(
    "falls back for more than four plausible fenced headers: %s", (header) => {
      expect(richPreviewAllowed(`${header}\ngraph TD; A --> B\n\n`.repeat(5))).toBe(false);
    });
  it("does not count ordinary code fences or inline references as diagrams", () => {
    expect(richPreviewAllowed("```typescript\nconst mermaid = true;\n```\n".repeat(20))).toBe(true);
    expect(richPreviewAllowed("Mermaid uses a ```mermaid header.\n".repeat(20))).toBe(true);
  });
});
