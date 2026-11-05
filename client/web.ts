import { codiumOriginSchema } from "../shared/settings";

// The cross-platform project deliberately has no DOM library. Browser capabilities stay here.
declare const URL: {
  new (input: string): {
    readonly origin: string;
    readonly host: string;
    readonly href: string;
    readonly searchParams: { set(key: string, value: string): void };
  };
};

export interface FileTarget { path: string; line?: number; column?: number }

function absolutePath(path: string): void {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("VSCodium needs an absolute path on the connected host.");
  }
}

export function resolveWorkspaceFile(folder: string, path: string): string {
  absolutePath(folder);
  if (!path || path.includes("\0")) throw new Error("Expected a file path on the connected host.");
  // Paseo file panels receive workspace-relative paths. Keep absolute targets
  // unchanged and use the actual checkout/worktree directory for relative ones.
  return path.startsWith("/") ? path : `${folder.replace(/\/+$/, "")}/${path}`;
}

export function makeCodiumUrl(base: string, folder: string, file?: FileTarget): string {
  codiumOriginSchema.parse(base);
  absolutePath(folder);
  const origin = new URL(base);
  const url = new URL(`${origin.origin}/`);
  url.searchParams.set("folder", folder);

  if (file) {
    absolutePath(file.path);
    const line = file.line ?? 1;
    const column = file.column ?? 1;
    if (![line, column].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Line and column must be positive integers.");
    }
    // Encode each segment, preserving literal %, #, ? and : within a filename.
    const path = file.path.split("/").map(encodeURIComponent).join("/");
    // VS Code's goto parser splits the decoded path on every colon and can discard
    // numeric filename segments. Preserve the file exactly when a path contains one.
    const payload = file.path.includes(":")
      ? [["openFile", `vscode-remote://${origin.host}${path}`]]
      : [["gotoLineMode", "true"], ["openFile", `vscode-remote://${origin.host}${path}:${line}:${column}`]];
    url.searchParams.set("payload", JSON.stringify(payload));
  }
  return url.href;
}

interface Frame {
  title: string; src: string; allow: string; referrerPolicy: string;
  style: Record<string, string>;
  remove(): void;
}
declare const document: { createElement(tag: "iframe"): Frame };

export function mountCodiumFrame(parent: unknown, url: string): () => void {
  if (!parent || typeof (parent as { appendChild?: unknown }).appendChild !== "function") {
    throw new Error("This client cannot embed VSCodium. Open it in your browser instead.");
  }
  const frame = document.createElement("iframe");
  frame.title = "VSCodium";
  frame.src = url;
  frame.allow = "clipboard-read; clipboard-write";
  frame.referrerPolicy = "no-referrer";
  Object.assign(frame.style, {
    border: "0", width: "100%", height: "100%", display: "block", flex: "1",
  });
  (parent as { appendChild(frame: Frame): void }).appendChild(frame);
  return () => frame.remove();
}
