import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const originMessage = "Use a plain HTTPS address without credentials, a path, a query or a fragment.";

export const codiumOriginSchema = z.string()
  .regex(/^https:\/\/[^/\\?#@\s]+\/?$/, originMessage)
  .refine((value) => value === value.trim(), originMessage)
  .pipe(z.string().url(originMessage));

// Empty is a safe, unconfigured installation. Launching still requires an origin.
export const connectionSchema = z.object({
  codiumBaseUrl: z.union([z.literal(""), codiumOriginSchema]).default(""),
  openMode: z.enum(["external", "embedded"]).default("external"),
}).strict();

export const codiumSettings = defineSettings({
  id: "connection", scope: "host", version: 1, schema: connectionSchema,
});
