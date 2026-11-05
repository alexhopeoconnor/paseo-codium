import { describe, expect, it } from "vitest";
import { connectionSchema } from "../shared/settings";
import { makeCodiumUrl } from "../client/web";

describe("connection settings", () => {
  it("installs safely without an address but cannot launch unconfigured", () => {
    expect(connectionSchema.parse({})).toEqual({ codiumBaseUrl: "", openMode: "external" });
    expect(() => makeCodiumUrl("", "/project")).toThrow();
  });

  it.each(["https://codium.example.com", "https://codium.example.com/", "https://codium.example.com:8443", "https://[::1]:8443"])("accepts an HTTPS origin: %s", (codiumBaseUrl) => {
    expect(connectionSchema.safeParse({ codiumBaseUrl }).success).toBe(true);
  });

  it.each([
    "http://codium.example.com", "javascript:alert(1)", "file:///project",
    "https://user:secret@codium.example.com", "https://codium.example.com/path",
    "https://codium.example.com/?tkn=secret", "https://codium.example.com/#section",
    "https://codium.example.com\\other", " https://codium.example.com",
    "https://codium.example.com:70000", "https://codium.example.com\n",
  ])("rejects an unsafe or ambiguous base URL: %s", (codiumBaseUrl) => {
    expect(connectionSchema.safeParse({ codiumBaseUrl }).success).toBe(false);
    expect(() => makeCodiumUrl(codiumBaseUrl, "/project")).toThrow();
  });

  it("rejects unknown settings and unsupported opening modes", () => {
    expect(connectionSchema.safeParse({ token: "secret" }).success).toBe(false);
    expect(connectionSchema.safeParse({ openMode: "shell" }).success).toBe(false);
  });
});
