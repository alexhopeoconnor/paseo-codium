import { randomUUID } from "node:crypto";

/** Telemetry-off Codium can expose the same placeholder env.sessionId in every window. */
export function createWindowIdentity(): string { return randomUUID(); }
