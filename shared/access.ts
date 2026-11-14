/** Access helper contract shared with the dependency-free Codium static helper. */
export const ACCESS_HELPER_PATH = "/_paseo/ready";
export const ACCESS_READY_TYPE = "paseo-codium-access-ready";
export const ACCESS_READY_VERSION = 1 as const;
export const ACCESS_NONCE_BYTES = 16;
export const ACCESS_NONCE_LENGTH = 32;
const ACCESS_NONCE_PATTERN = /^[a-f0-9]{32}$/;

export function isAccessNonce(value: unknown): value is string {
  return typeof value === "string" && ACCESS_NONCE_PATTERN.test(value);
}

/** The helper receives the nonce in the URL fragment so it never reaches a proxy log. */
export function accessNonceFromFragment(fragment: string): string | undefined {
  const match = /^#nonce=([a-f0-9]{32})$/.exec(fragment);
  return match?.[1];
}

export function accessProbeUrl(origin: string, nonce: string): string {
  if (!isAccessNonce(nonce)) throw new Error("Invalid Codium access nonce.");
  return `${origin}${ACCESS_HELPER_PATH}#nonce=${nonce}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AccessReadyMessage {
  type: typeof ACCESS_READY_TYPE;
  version: typeof ACCESS_READY_VERSION;
  nonce: string;
}

/** Exact schema: the helper must not add fields the parent has not reviewed. */
export function parseAccessReadyMessage(value: unknown): AccessReadyMessage {
  if (record(value) && Object.keys(value).length === 3 &&
      value.type === ACCESS_READY_TYPE && value.version === ACCESS_READY_VERSION && isAccessNonce(value.nonce)) {
    return { type: ACCESS_READY_TYPE, version: ACCESS_READY_VERSION, nonce: value.nonce };
  }
  throw new Error("Invalid Codium access-ready message.");
}

export interface AccessProbeEvent {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

export interface AccessProbeExpectation {
  /** Effective Codium origin, exactly as configured and normalized. */
  origin: string;
  /** The live probe iframe's contentWindow. */
  source: unknown;
  nonce: string;
}

/** Parent-side gate: exact origin, exact iframe window, exact current nonce and schema. */
export function acceptAccessReady(event: AccessProbeEvent, expected: AccessProbeExpectation): boolean {
  if (event.origin !== expected.origin || !expected.source || event.source !== expected.source) return false;
  let message: AccessReadyMessage;
  try { message = parseAccessReadyMessage(event.data); } catch { return false; }
  return isAccessNonce(expected.nonce) && message.nonce === expected.nonce;
}
