import { codiumOriginSchema } from "../shared/settings";
import { BOOTSTRAP_SCHEME } from "../shared/wire";
export type { FileTarget } from "../shared/wire";
import type { FileTarget } from "../shared/wire";

// The cross-platform project deliberately has no DOM library. Browser capabilities stay here.
declare const URL: {
  new (input: string): {
    readonly origin: string;
    readonly host: string;
    readonly href: string;
    readonly searchParams: { set(key: string, value: string): void };
  };
};

declare const crypto: { randomUUID(): string };
declare const performance: { timeOrigin: number };
export function browserDocumentEpoch(): number {
  return typeof performance === "undefined" ? 0 : performance.timeOrigin;
}
export function newRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() :
    `request_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

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

export function makeBootstrapUrl(base: string, folder: string, bootstrapKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(bootstrapKey)) throw new Error("Invalid editor pairing key.");
  const url = new URL(makeCodiumUrl(base, folder));
  url.searchParams.set("payload", JSON.stringify([["openFile", `${BOOTSTRAP_SCHEME}://pair/${bootstrapKey}/session.txt`]]));
  return url.href;
}

interface Frame {
  title: string; src: string; allow: string; referrerPolicy: string;
  style: Record<string, string>;
  remove(): void;
}
declare const document: {
  createElement(tag: "iframe"): Frame;
  activeElement: unknown;
  visibilityState: string;
  addEventListener(type: string, listener: () => void, capture?: boolean): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
};
interface VisiblePanel {
  isConnected: boolean;
  getBoundingClientRect(): { width: number; height: number };
}
declare const IntersectionObserver: {
  new (callback: (entries: { isIntersecting: boolean }[]) => void): {
    observe(target: VisiblePanel): void;
    disconnect(): void;
  };
};

/** Wait for the actual web panel, not a retained hidden tab, before focusing Codium. */
export function panelHasVisibleBounds(parent: unknown): boolean {
  if (!parent || typeof (parent as VisiblePanel).getBoundingClientRect !== "function") return false;
  const panel = parent as VisiblePanel, bounds = panel.getBoundingClientRect();
  return panel.isConnected && bounds.width > 0 && bounds.height > 0 && document.visibilityState === "visible";
}

export function observePanelVisibility(parent: unknown, changed: (visible: boolean) => void): () => void {
  if (!parent || typeof (parent as VisiblePanel).getBoundingClientRect !== "function" || typeof IntersectionObserver === "undefined") return () => {};
  const panel = parent as VisiblePanel;
  let intersecting = false;
  const inspect = () => {
    changed(intersecting && panelHasVisibleBounds(panel));
  };
  const observer = new IntersectionObserver((entries) => { intersecting = entries.some((entry) => entry.isIntersecting); inspect(); });
  observer.observe(panel);
  document.addEventListener("visibilitychange", inspect);
  return () => { observer.disconnect(); document.removeEventListener("visibilitychange", inspect); };
}
declare const window: {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  setTimeout(listener: () => void, delay: number): number;
  clearTimeout(timer: number): void;
};

export function mountCodiumFrame(parent: unknown, url: string, onFocusChange?: (focused: boolean) => void): () => void {
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
  let focusTimer: number | undefined;
  let priorFocus = false;
  const inspectFocus = () => {
    const focused = document.activeElement === frame;
    if (focused !== priorFocus) { priorFocus = focused; onFocusChange?.(focused); }
  };
  const deferFocus = () => {
    inspectFocus();
    if (focusTimer !== undefined) window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(inspectFocus, 0);
  };
  window.addEventListener("blur", deferFocus);
  window.addEventListener("focus", deferFocus);
  document.addEventListener("focusin", deferFocus, true);
  document.addEventListener("pointerdown", deferFocus, true);
  return () => {
    window.removeEventListener("blur", deferFocus); window.removeEventListener("focus", deferFocus);
    document.removeEventListener("focusin", deferFocus, true); document.removeEventListener("pointerdown", deferFocus, true);
    if (focusTimer !== undefined) window.clearTimeout(focusTimer);
    frame.remove();
  };
}
