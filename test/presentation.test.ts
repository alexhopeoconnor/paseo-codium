import { describe, expect, it, vi } from "vitest";
import type { PluginTab } from "@getpaseo/plugin/client";
import { editorConnectionKey } from "../client/editor-session";
import { closeProtectionSetter, retainedTabSetter } from "../client/host-capabilities";
import { PresentationGate, connectionSchema, knownClosePrimarySidebar, presentationPreferenceSchema } from "../shared/settings";

describe("presentation stays outside editor identity", () => {
  it("keeps the same connection key regardless of the sidebar preference", () => {
    const connection = { codiumBaseUrl: "https://codium.example.com", openMode: "embedded" as const };
    const key = editorConnectionKey(connection);
    expect(editorConnectionKey({ ...connection })).toBe(key);
    expect(key).toBe(JSON.stringify(["https://codium.example.com", "embedded"]));
    expect(key).not.toContain("sidebar");
    expect(connectionSchema.safeParse({ ...connection, closePrimarySidebar: false }).success).toBe(false);
  });
  it("defaults the Codium sidebar to closing once and allows an explicit keep preference", () => {
    expect(presentationPreferenceSchema.parse({})).toEqual({ closePrimarySidebar: true });
    expect(presentationPreferenceSchema.parse({ closePrimarySidebar: false })).toEqual({ closePrimarySidebar: false });
    expect(presentationPreferenceSchema.safeParse({ closePrimarySidebar: "yes" }).success).toBe(false);
  });
  it("never guesses a presentation value before settings are known", () => {
    expect(knownClosePrimarySidebar({ status: "loading" })).toBeUndefined();
    expect(knownClosePrimarySidebar({ status: "invalid", values: { closePrimarySidebar: true } })).toBeUndefined();
    expect(knownClosePrimarySidebar({ status: "ready", values: { closePrimarySidebar: false } })).toBe(false);
    expect(knownClosePrimarySidebar({ status: "ready", values: { closePrimarySidebar: true } })).toBe(true);
    expect(knownClosePrimarySidebar({ status: "ready", values: { closePrimarySidebar: "yes" } })).toBeUndefined();
  });
  it("keeps an already-mounted editor gate defined through loading/error and caches a later ready value", () => {
    const gate = new PresentationGate();
    expect(gate.update({ status: "loading" })).toBeUndefined();
    expect(gate.update({ status: "ready", values: { closePrimarySidebar: false } })).toBe(false);
    // The editor is now mounted; these states must not close the gate.
    expect(gate.update({ status: "loading" })).toBe(false);
    expect(gate.update({ status: "error" })).toBe(false);
    expect(gate.update({ status: "invalid", values: { closePrimarySidebar: true } })).toBe(false);
    // A later valid value is cached for a future paired window; the current
    // EmbeddedEditor effect does not depend on this prop and stays mounted.
    expect(gate.update({ status: "ready", values: { closePrimarySidebar: true } })).toBe(true);
    expect(gate.current).toBe(true);
  });
  it("retains the mounted editor only through the capable stable tab setter", () => {
    const setRetained = vi.fn(), tab = { setRetained } as unknown as PluginTab;
    expect(retainedTabSetter(tab, false)).toBeUndefined();
    expect(retainedTabSetter({} as PluginTab, true)).toBeUndefined();
    const setter = retainedTabSetter(tab, true);
    expect(setter).toBe(setRetained);
    setter!(true); setter!(false);
    expect(setRetained.mock.calls).toEqual([[true], [false]]);
  });
  it("uses the same stable close-protection setter for fresh snapshots", () => {
    const setter = vi.fn(), tab = { setCloseProtectionResolver: setter } as unknown as PluginTab;
    expect(closeProtectionSetter(tab, false)).toBeUndefined();
    expect(closeProtectionSetter({} as PluginTab, true)).toBeUndefined();
    const stable = closeProtectionSetter(tab, true);
    expect(stable).toBe(setter);
    stable!(null);
    expect(setter).toHaveBeenCalledWith(null);
  });
});
