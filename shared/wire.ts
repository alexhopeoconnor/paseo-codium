/** Protocol shared with the dependency-free Codium companion. */
export const MAX_FRAME_BYTES = 32 * 1024;
export const BOOTSTRAP_SCHEME = "paseo-codium-session";
/** A stream read may contain several messages or only part of one message. */
export class MessageFramer {
  private readonly buffer = new Uint8Array(MAX_FRAME_BYTES);
  private length = 0;
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let start = 0;
    const append = (end: number) => {
      const length = end - start;
      if (this.length + length > MAX_FRAME_BYTES) throw new Error("Editor protocol frame is too large.");
      this.buffer.set(chunk.subarray(start, end), this.length);
      this.length += length;
    };
    for (let end = 0; end < chunk.length; end++) {
      if (chunk[end] !== 10) continue;
      append(end);
      frames.push(this.buffer.slice(0, this.length));
      this.length = 0; start = end + 1;
    }
    append(chunk.length);
    return frames;
  }
}
export interface FileTarget { path: string; line?: number; column?: number; lineEnd?: number }
export type CompanionMessage =
  | { protocol: 1; type: "hello"; bootstrapKey: string; windowId: string; connectionId: string; workspace: string }
  | { protocol: 1; type: "state"; sequence: number; dirty: boolean }
  | { protocol: 1; type: "snapshot"; requestId: string; sequence: number; dirty: boolean }
  | { protocol: 1; type: "result"; requestId: string; ok: boolean; error?: string };
export type BrokerMessage =
  | { protocol: 1; type: "bound"; sessionId: string }
  | { protocol: 1; type: "openFile"; requestId: string; target: FileTarget }
  | { protocol: 1; type: "getState"; requestId: string }
  | { protocol: 1; type: "error"; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}
export function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 8192 && !value.includes("\0");
}
export function validTarget(value: unknown): value is FileTarget {
  if (!record(value) || !keys(value, ["path", "line", "column", "lineEnd"]) || !absolutePath(value.path)) return false;
  for (const key of ["line", "column", "lineEnd"]) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1)) return false;
  }
  return value.lineEnd === undefined || (value.lineEnd as number) >= (value.line as number | undefined ?? 1);
}
export function parseCompanionMessage(value: unknown): CompanionMessage {
  if (record(value) && value.protocol === 1) {
    if (value.type === "hello" && keys(value, ["protocol", "type", "bootstrapKey", "windowId", "connectionId", "workspace"]) &&
      typeof value.bootstrapKey === "string" && /^[a-f0-9]{64}$/.test(value.bootstrapKey) &&
      identifier(value.windowId) && identifier(value.connectionId) && absolutePath(value.workspace)) return value as unknown as CompanionMessage;
    if (value.type === "state" && keys(value, ["protocol", "type", "sequence", "dirty"]) && Number.isSafeInteger(value.sequence) &&
      (value.sequence as number) > 0 && typeof value.dirty === "boolean") return value as unknown as CompanionMessage;
    if (value.type === "snapshot" && keys(value, ["protocol", "type", "requestId", "sequence", "dirty"]) && identifier(value.requestId) &&
      Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 && typeof value.dirty === "boolean") return value as unknown as CompanionMessage;
    if (value.type === "result" && keys(value, ["protocol", "type", "requestId", "ok", "error"]) && identifier(value.requestId) &&
      typeof value.ok === "boolean" && (value.error === undefined || (typeof value.error === "string" && value.error.length <= 1000))) return value as unknown as CompanionMessage;
  }
  throw new Error("Invalid companion protocol message.");
}
export function parseBrokerMessage(value: unknown): BrokerMessage {
  if (record(value) && value.protocol === 1) {
    if (value.type === "bound" && keys(value, ["protocol", "type", "sessionId"]) && identifier(value.sessionId)) return value as unknown as BrokerMessage;
    if (value.type === "openFile" && keys(value, ["protocol", "type", "requestId", "target"]) && identifier(value.requestId) && validTarget(value.target)) return value as unknown as BrokerMessage;
    if (value.type === "getState" && keys(value, ["protocol", "type", "requestId"]) && identifier(value.requestId)) return value as unknown as BrokerMessage;
    if (value.type === "error" && keys(value, ["protocol", "type", "message"]) && typeof value.message === "string" && value.message.length <= 1000) return value as unknown as BrokerMessage;
  }
  throw new Error("Invalid broker protocol message.");
}
