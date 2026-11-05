import { describe, expect, it } from "vitest";
import { makeCodiumUrl } from "../client/web";

const origin = "https://codium.example.com";

describe("Codium workspace and file navigation", () => {
  it("opens the actual worktree directory without adding a file payload", () => {
    const folder = "/home/alex/.worktrees/project/feature one";
    const result = new URL(makeCodiumUrl(origin, folder));
    expect(result.origin).toBe(origin);
    expect(result.searchParams.get("folder")).toBe(folder);
    expect(result.searchParams.has("payload")).toBe(false);
  });

  it.each([
    "/home/alex/project/app.py",
    "/home/alex/project/a space/naïve 日本語.py",
    "/home/alex/project/literal%20file#part?query.py",
    "/home/alex/project/ampersand&equals=plus+.ts",
  ])("preserves the file path and cursor independently: %s", (path) => {
    const folder = "/home/alex/project";
    const result = new URL(makeCodiumUrl(origin, folder, { path, line: 42, column: 5 }));
    expect(result.searchParams.get("folder")).toBe(folder);
    const payload = new Map<string, string>(JSON.parse(result.searchParams.get("payload")!));
    expect(payload.get("gotoLineMode")).toBe("true");
    const target = new URL(payload.get("openFile")!);
    expect(target.protocol).toBe("vscode-remote:");
    expect(target.host).toBe("codium.example.com");
    expect(target.search).toBe("");
    expect(target.hash).toBe("");
    expect(target.pathname.endsWith(":42:5")).toBe(true);
    expect(decodeURIComponent(target.pathname.slice(0, -5))).toBe(path);
  });

  it.each([
    "/home/alex/project/literal%20file#part?query:12:4.py",
    "/home/alex/project/colon:directory/app.py",
    "/home/alex/project/filename:12:4",
    "/home/alex/project/a::b.txt",
  ])("preserves a colon-containing path using file-only navigation: %s", (path) => {
    const result = new URL(makeCodiumUrl(origin, "/home/alex/project", { path, line: 42, column: 5 }));
    const payload = new Map<string, string>(JSON.parse(result.searchParams.get("payload")!));
    expect(payload.has("gotoLineMode")).toBe(false);
    const target = new URL(payload.get("openFile")!);
    expect(decodeURIComponent(target.pathname)).toBe(path);
    expect(target.search).toBe("");
    expect(target.hash).toBe("");
  });

  it("accounts for upstream goto parsing numeric segments anywhere in a decoded path", () => {
    // The selected VSCodium 1.143.17232 workbench calls parseLineAndColumnAware
    // after URI.parse has decoded the path. Model that behavior independently.
    function parseLikeWorkbench(path: string) {
      const pathParts: string[] = [];
      const positions: number[] = [];
      for (const segment of path.split(":")) {
        const value = Number(segment);
        if (Number.isNaN(value)) pathParts.push(segment);
        else if (positions.length < 2) positions.push(value);
      }
      return { path: pathParts.join(":"), line: positions[0], column: positions[1] ?? 1 };
    }
    const path = "/project/report:12:4.txt";
    expect(parseLikeWorkbench(`${path}:42:5`)).toEqual({ path: "/project/report:4.txt", line: 12, column: 42 });
    const result = new URL(makeCodiumUrl(origin, "/project", { path, line: 42, column: 5 }));
    const payload = new Map<string, string>(JSON.parse(result.searchParams.get("payload")!));
    const decoded = decodeURIComponent(new URL(payload.get("openFile")!).pathname);
    const opened = payload.has("gotoLineMode") ? parseLikeWorkbench(decoded).path : decoded;
    expect(opened).toBe(path);
  });

  it("normalizes the origin and retains a nondefault HTTPS port", () => {
    const result = new URL(makeCodiumUrl("https://CODIUM.example.com:8443/", "/project", { path: "/project/a.py" }));
    const payload = new Map<string, string>(JSON.parse(result.searchParams.get("payload")!));
    expect(result.origin).toBe("https://codium.example.com:8443");
    expect(payload.get("openFile")).toBe("vscode-remote://codium.example.com:8443/project/a.py:1:1");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cursor position %s", (line) => {
    expect(() => makeCodiumUrl(origin, "/project", { path: "/project/a.py", line })).toThrow();
    expect(() => makeCodiumUrl(origin, "/project", { path: "/project/a.py", column: line })).toThrow();
  });

  it.each(["relative/project", "", "/project\0other"])('rejects an invalid folder "%s"', (folder) => {
    expect(() => makeCodiumUrl(origin, folder)).toThrow();
  });

  it("rejects relative or NUL-containing files", () => {
    expect(() => makeCodiumUrl(origin, "/project", { path: "a.py" })).toThrow();
    expect(() => makeCodiumUrl(origin, "/project", { path: "/project/a\0.py" })).toThrow();
  });
});
