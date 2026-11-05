import { describe, expect, it } from "vitest";
import { cursorRange } from "../shared/positions";

describe("editor coordinates", () => {
  it("selects one-based line ranges inclusively", () => {
    const lengths = [6, 12, 3, 8];
    expect(cursorRange({ path: "/file", line: 2, column: 4, lineEnd: 3 }, lengths.length, (line) => lengths[line]!))
      .toEqual({ startLine: 1, startColumn: 3, endLine: 2, endColumn: 3 });
  });
  it("clamps positions to real document bounds", () => {
    expect(cursorRange({ path: "/file", line: 500, column: 900 }, 1, () => 0))
      .toEqual({ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 });
  });
  it("does not read every line of a large file for a cursor jump", () => {
    const touched: number[] = [];
    expect(cursorRange({ path: "/file", line: 42, column: 5 }, 100_000, (line) => { touched.push(line); return 10; }))
      .toEqual({ startLine: 41, startColumn: 4, endLine: 41, endColumn: 4 });
    expect(touched).toEqual([41]);
  });
});
