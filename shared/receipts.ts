import { z } from "zod";

/** Bounded diagnostic memory, not a transaction log and not exactly-once delivery. */
export const RECEIPT_VERSION = 2;
export const RECEIPT_TTL_MS = 15 * 60_000;
export const MAX_RECEIPTS = 256;

export const fileOpenStageSchema = z.enum([
  "host_route", "access_probe", "pairing", "bridge", "queue", "execution", "ack",
]);
export const fileOpenOutcomeSchema = z.enum([
  "pending", "not_sent", "queued", "sent", "opened", "failed", "uncertain",
]);
export const fileOpenReasonSchema = z.enum([
  "cancelled", "access_unconfirmed", "pairing_failed", "bridge_unavailable", "queue_expired",
  "capacity", "timeout", "disconnected", "session_closed", "connection_changed", "conflict",
  "fallback", "not_ready", "invalid",
]);
const id = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);

/**
 * Stage is a diagnostic marker of the furthest attempted boundary. It is never
 * proof that the editor executed anything; only an authoritative editor result
 * can distinguish opened/failed from uncertain.
 */
export const fileOpenReceiptSchema = z.object({
  version: z.literal(RECEIPT_VERSION),
  correlationId: id,
  requestId: id,
  stage: fileOpenStageSchema,
  outcome: fileOpenOutcomeSchema,
  dispatched: z.boolean(),
  reason: fileOpenReasonSchema.optional(),
  updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
}).strict();
export type FileOpenStage = z.infer<typeof fileOpenStageSchema>;
export type FileOpenOutcome = z.infer<typeof fileOpenOutcomeSchema>;
export type FileOpenReason = z.infer<typeof fileOpenReasonSchema>;
export type FileOpenReceipt = z.infer<typeof fileOpenReceiptSchema>;

const stageOrder: FileOpenStage[] = ["host_route", "access_probe", "pairing", "bridge", "queue", "execution", "ack"];
export function laterStage(left: FileOpenStage, right: FileOpenStage): FileOpenStage {
  return stageOrder.indexOf(left) >= stageOrder.indexOf(right) ? left : right;
}
export function terminalOutcome(outcome: FileOpenOutcome): boolean {
  return outcome === "not_sent" || outcome === "opened" || outcome === "failed" || outcome === "uncertain";
}

/** User-facing receipt text. Null/expired memory is UNKNOWN, never not-sent. */
export function describeFileOpenReceipt(receipt: FileOpenReceipt | null | undefined): string {
  if (!receipt) return "Outcome unknown. No retained receipt is available; this does not mean the request was not sent.";
  return `Request ${receipt.requestId} · outcome ${receipt.outcome} · stage ${receipt.stage}${receipt.reason ? ` · ${receipt.reason}` : ""}`;
}
