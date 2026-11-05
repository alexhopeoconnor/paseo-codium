import { describe, expect, it } from "vitest";
import { parseBrokerMessage, parseCompanionMessage, validTarget } from "../shared/wire";
import { targetSchema } from "../shared/rpc";
import { createWindowIdentity } from "../companion/src/identity";

describe("narrow companion wire protocol", () => {
  it("uses independent valid window identities when Codium telemetry has only a shared placeholder", () => {
    // The installed NullTelemetryService exposes env.sessionId='someValue.sessionId'.
    // Window binding must not depend on that telemetry identifier.
    const first = createWindowIdentity(); const second = createWindowIdentity();
    expect(first).not.toBe(second);
    for (const windowId of [first, second]) {
      expect(parseCompanionMessage({ protocol: 1, type: "hello", bootstrapKey: "a".repeat(64), windowId,
        connectionId: "connection_1234", workspace: "/project" }).type).toBe("hello");
    }
  });
  it.each([
    { type: "shell", protocol: 1, command: "ls" },
    { type: "state", protocol: 2, sequence: 1, dirty: false },
    { type: "state", protocol: 1, sequence: -1, dirty: false },
    { type: "state", protocol: 1, sequence: 1, dirty: "false" },
    { type: "state", protocol: 1, sequence: 1, dirty: false, command: "extra" },
  ])("rejects malformed or unsupported companion messages", (message) => {
    expect(() => parseCompanionMessage(message)).toThrow();
  });
  it.each([
    { path: "relative" }, { path: "/bad\0file" }, { path: "/file", line: 0 },
    { path: "/file", line: 4, lineEnd: 2 }, { path: "/file", column: 1.5 },
    { path: "/file", executeCommand: "anything" },
  ])("rejects invalid file targets at both RPC and socket boundaries", (target) => {
    expect(validTarget(target)).toBe(false);
    expect(targetSchema.safeParse(target).success).toBe(false);
    expect(() => parseBrokerMessage({ protocol: 1, type: "openFile", requestId: "request_1234", target })).toThrow();
  });
  it("preserves absolute targets and ranges without a goto URL parser", () => {
    const target = { path: "/other project/naïve%20#?:12:4.txt", line: 3, lineEnd: 5, column: 2 };
    expect(validTarget(target)).toBe(true);
    expect(targetSchema.parse(target)).toEqual(target);
    expect(parseBrokerMessage({ protocol: 1, type: "openFile", requestId: "request_1234", target })).toEqual({ protocol: 1, type: "openFile", requestId: "request_1234", target });
  });
});
