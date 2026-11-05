import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const secret = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().max(8192).startsWith("/").refine((path) => !path.includes("\0"));
const coordinate = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const targetSchema = z.object({ path: absolute, line: coordinate.optional(), column: coordinate.optional(), lineEnd: coordinate.optional() }).strict()
  .refine((target) => target.lineEnd === undefined || target.lineEnd >= (target.line ?? 1), "Invalid line range.");
const auth = { sessionId: id, ownerKey: secret };
export const sessionStateSchema = z.object({ connected: z.boolean(), known: z.boolean(), dirty: z.boolean(), sequence: z.number().int().nonnegative(), expired: z.boolean() }).strict();
export type SessionState = z.infer<typeof sessionStateSchema>;
export const createSessionRpc = defineRpc({
  name: "editor.create",
  input: z.object({ workspaceId: z.string().min(1).max(128), clientId: id }).strict(),
  output: z.object({ ...auth, bootstrapKey: secret, directory: absolute, protocolVersion: z.literal(1) }).strict(),
});
export const sessionStateRpc = defineRpc({ name: "editor.state", input: z.object(auth).strict(), output: sessionStateSchema });
export const openFileRpc = defineRpc({
  name: "editor.open-file", input: z.object({ ...auth, requestId: id, target: targetSchema }).strict(),
  output: z.object({ requestId: id, opened: z.literal(true) }).strict(),
});
export const releaseSessionRpc = defineRpc({
  name: "editor.release", input: z.object(auth).strict(), output: z.object({ released: z.literal(true) }).strict(),
});
