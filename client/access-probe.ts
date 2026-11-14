import {
  ACCESS_HELPER_PATH, ACCESS_NONCE_BYTES, acceptAccessReady, accessProbeUrl, isAccessNonce,
  type AccessProbeEvent,
} from "../shared/access";

export type AccessProbeOutcome = "ready" | "timeout" | "cancelled";
export interface AccessProbeFrame { readonly contentWindow: unknown; remove(): void }
export interface AccessProbeEnvironment {
  open(url: string): AccessProbeFrame;
  listen(listener: (event: AccessProbeEvent) => void): () => void;
  setTimeout(listener: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
  randomBytes(bytes: Uint8Array): void;
}
export interface AccessProbe {
  readonly nonce: string;
  readonly result: Promise<AccessProbeOutcome>;
  cancel(): void;
}
export const ACCESS_PROBE_TIMEOUT_MS = 8_000;

// Client TypeScript deliberately excludes DOM globals. Declare only what this module uses.
interface BrowserFrame {
  title: string; src: string; referrerPolicy: string; tabIndex: number;
  style: Record<string, string>;
  readonly contentWindow: unknown;
  remove(): void;
}
declare const document: {
  body: { appendChild(frame: BrowserFrame): void } | null;
  createElement(tag: "iframe"): BrowserFrame;
};
declare const window: {
  addEventListener(type: "message", listener: (event: AccessProbeEvent) => void): void;
  removeEventListener(type: "message", listener: (event: AccessProbeEvent) => void): void;
  open(url: string, target: string, features: string): unknown;
  setTimeout(listener: () => void, delay: number): number;
  clearTimeout(timer: number): void;
};
declare const crypto: { getRandomValues?(values: Uint8Array): Uint8Array };
declare const URL: { new (input: string): { readonly origin: string } };

export function normalizeCodiumOrigin(origin: string): string {
  return new URL(origin).origin;
}

function secureRandomBytes(values: Uint8Array): void {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random values are unavailable for the Codium access check.");
  }
  crypto.getRandomValues(values);
}

export function newAccessNonce(randomBytes: (values: Uint8Array) => void = secureRandomBytes): string {
  const values = new Uint8Array(ACCESS_NONCE_BYTES);
  randomBytes(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function browserAccessEnvironment(): AccessProbeEnvironment {
  return {
    open(url) {
      if (typeof document === "undefined" || !document.body) throw new Error("This client cannot check Codium access.");
      const frame = document.createElement("iframe");
      frame.title = "VSCodium access check";
      frame.referrerPolicy = "no-referrer";
      frame.tabIndex = -1;
      Object.assign(frame.style, {
        position: "fixed", left: "-10000px", top: "0", width: "1px", height: "1px",
        border: "0", opacity: "0", pointerEvents: "none",
      });
      frame.src = url;
      document.body.appendChild(frame);
      return { get contentWindow() { return frame.contentWindow; }, remove() { frame.remove(); } };
    },
    listen(listener) {
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
    setTimeout(listener, delay) { return window.setTimeout(listener, delay); },
    clearTimeout(timer) { window.clearTimeout(timer as number); },
    // The production adapter must fill the caller's buffer directly from the
    // platform CSPRNG. Tests inject randomBytes separately.
    randomBytes(values) { secureRandomBytes(values); },
  };
}

/**
 * Probe authenticated same-origin access through the reviewed /_paseo/ready helper.
 * A ready result proves access only: pairing, the Codium backend and the companion
 * bridge are confirmed later by their own messages.
 */
export function probeCodiumAccess(
  origin: string,
  options: { nonce?: string; timeoutMs?: number; environment?: AccessProbeEnvironment } = {},
): AccessProbe {
  const environment = options.environment ?? browserAccessEnvironment();
  const normalized = normalizeCodiumOrigin(origin);
  const nonce = options.nonce ?? newAccessNonce((values) => environment.randomBytes(values));
  if (!isAccessNonce(nonce)) throw new Error("Invalid Codium access nonce.");
  const timeoutMs = options.timeoutMs ?? ACCESS_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Codium access timeout.");

  let frame: AccessProbeFrame | undefined;
  let settled = false;
  let timer: unknown;
  let resolveResult!: (outcome: AccessProbeOutcome) => void;
  const result = new Promise<AccessProbeOutcome>((resolve) => { resolveResult = resolve; });
  let removeListener = () => {};
  const finish = (outcome: AccessProbeOutcome) => {
    if (settled) return;
    settled = true;
    environment.clearTimeout(timer);
    removeListener();
    try { frame?.remove(); } catch { /* The helper frame may already be gone. */ }
    resolveResult(outcome);
  };
  removeListener = environment.listen((event) => {
    if (settled) return;
    if (acceptAccessReady(event, { origin: normalized, source: frame?.contentWindow, nonce })) finish("ready");
  });
  timer = environment.setTimeout(() => finish("timeout"), timeoutMs);
  try {
    frame = environment.open(accessProbeUrl(normalized, nonce));
  } catch (error) {
    finish("timeout");
    throw error;
  }
  return { nonce, result, cancel() { finish("cancelled"); } };
}

/** Opens the helper page, never the IDE root, in a top-level user-gesture window. */
export function openAccessHelper(origin: string): void {
  const url = `${normalizeCodiumOrigin(origin)}${ACCESS_HELPER_PATH}`;
  if (typeof window === "undefined" || typeof window.open !== "function") {
    throw new Error("This client cannot open the Codium sign-in page.");
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
