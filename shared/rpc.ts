import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { fileOpenReceiptSchema } from "./receipts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const secret = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().max(8192).startsWith("/").refine((path) => !path.includes("\0"));
const coordinate = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const targetSchema = z.object({ path: absolute, line: coordinate.optional(), column: coordinate.optional(), lineEnd: coordinate.optional() }).strict()
  .refine((target) => target.lineEnd === undefined || target.lineEnd >= (target.line ?? 1), "Invalid line range.");
const auth = { sessionId: id, ownerKey: secret };
const activeFile = z.string().min(1).max(8192).nullable().refine((value) => value === null ||
  (!value.startsWith("/") && !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")),
  "Invalid active file path.");
export const sessionStateSchema = z.object({
  connected: z.boolean(), known: z.boolean(), dirty: z.boolean(), sequence: z.number().int().nonnegative(),
  expired: z.boolean(), activeFile: activeFile.optional(),
}).strict();
export type SessionState = z.infer<typeof sessionStateSchema>;
export const presentationSchema = z.object({ closePrimarySidebar: z.boolean() }).strict();
export type PresentationSettings = z.infer<typeof presentationSchema>;
export const createSessionRpc = defineRpc({
  name: "editor.create",
  input: z.object({ workspaceId: z.string().min(1).max(128), clientId: id, presentation: presentationSchema }).strict(),
  output: z.object({ ...auth, bootstrapKey: secret, directory: absolute, protocolVersion: z.literal(2) }).strict(),
});
/** Routine polling reads the cached heartbeat state; it never asks the editor. */
export const sessionStateRpc = defineRpc({ name: "editor.state", input: z.object(auth).strict(), output: sessionStateSchema });
/** Close protection always requests a new paired-window snapshot. */
export const snapshotRpc = defineRpc({ name: "editor.snapshot", input: z.object(auth).strict(), output: sessionStateSchema });
export const openFileRpc = defineRpc({
  name: "editor.open-file",
  input: z.object({ ...auth, requestId: id, target: targetSchema }).strict(),
  output: z.object({ requestId: id, receipt: fileOpenReceiptSchema }).strict(),
});
export const receiptRpc = defineRpc({
  name: "editor.receipt",
  input: z.object({ ...auth, requestId: id }).strict(),
  output: z.object({ receipt: fileOpenReceiptSchema.nullable() }).strict(),
});
export const cancelRequestRpc = defineRpc({
  name: "editor.cancel",
  input: z.object({ ...auth, requestId: id }).strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
});
export const releaseSessionRpc = defineRpc({
  name: "editor.release", input: z.object(auth).strict(), output: z.object({ released: z.literal(true) }).strict(),
});
