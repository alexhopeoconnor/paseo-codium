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

/** Presentation preference only: it never participates in an editor connection identity. */
export const presentationPreferenceSchema = z.object({
  closePrimarySidebar: z.boolean().default(true),
}).strict();

export const codiumPresentationSettings = defineSettings({
  id: "presentation", scope: "host", version: 1, schema: presentationPreferenceSchema,
});

/** Undefined means settings are not yet known; never fall back to a guessed value. */
export function knownClosePrimarySidebar(state: { status: string; values?: unknown }): boolean | undefined {
  if (state.status !== "ready") return undefined;
  const parsed = presentationPreferenceSchema.safeParse(state.values);
  return parsed.success ? parsed.data.closePrimarySidebar : undefined;
}

/**
 * Gates the first pairing but never closes an already-mounted editor. Once a
 * valid preference is known, later loading/error/invalid states keep the last
 * value so the retained iframe is not unmounted. A new ready value is cached for
 * the next paired window without remounting the current effect.
 */
export class PresentationGate {
  private value?: boolean;
  update(state: { status: string; values?: unknown }): boolean | undefined {
    const next = knownClosePrimarySidebar(state);
    if (next !== undefined) this.value = next;
    return this.value;
  }
  get current(): boolean | undefined { return this.value; }
}
