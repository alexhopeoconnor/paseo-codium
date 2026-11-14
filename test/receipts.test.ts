import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { EditorSessions, type Session } from "../server/sessions";
import { MAX_RECEIPTS, RECEIPT_TTL_MS, describeFileOpenReceipt, fileOpenReceiptSchema } from "../shared/receipts";

describe("file-open receipt identity and outcomes", () => {
  let directory: string;
  let now: number;
  let sessions: EditorSessions;
  let session: Session;
  let writes: string[];
  let socket: Socket;
  let rawSocket: { destroyed: boolean; write(data: string): boolean; destroy(): void };
  const target = { path: "/worktree/src/main.ts", line: 4, lineEnd: 8 };
  const frames = () => writes.map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codium-receipt-test-"));
    now = 1_000;
    sessions = new EditorSessions(() => now);
    const created = sessions.create("workspace_a", "client_a", directory);
    writes = [];
    rawSocket = {
      destroyed: false,
      write(data: string) { writes.push(data); return true; },
      destroy() { rawSocket.destroyed = true; },

    };
    socket = rawSocket as unknown as Socket;
    session = await sessions.bind(created.bootstrapKey, directory, "window_a", "connection_a", socket);
    sessions.update(session, 1, false);
  });
  afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

  it("reserves request id and fingerprint before writing; duplicates join the same receipt", async () => {
    const first = sessions.open(session, "request_same", target);
    const second = sessions.open(session, "request_same", { ...target });
    expect(second).toBe(first);
    expect(writes).toHaveLength(1);
    expect(sessions.receipt(session, "request_same")).toMatchObject({ outcome: "sent", stage: "execution", dispatched: true, requestId: "request_same" });
    expect(frames()[0]).toEqual({ protocol: 2, type: "openFile", requestId: "request_same", target });
    expect(JSON.stringify(frames())).not.toContain("ownerKey");
    sessions.result(session, "request_same", true);
    const opened = await first;
    expect(opened).toMatchObject({ outcome: "opened", stage: "ack", dispatched: true });
    expect(fileOpenReceiptSchema.safeParse(opened).success).toBe(true);
    expect((await sessions.open(session, "request_same", target)).outcome).toBe("opened");
    expect(writes).toHaveLength(1);
  });

  it("fails conflicting identifier reuse without a second dispatch", async () => {
    sessions.open(session, "request_conflict", target);
    await expect(sessions.open(session, "request_conflict", { path: "/different" })).rejects.toThrow("reused for a different file");
    expect(writes).toHaveLength(1);
  });

  it("reports an authoritative editor failure but keeps the identity queryable", async () => {
    const receipt = sessions.open(session, "request_failed", target);
    sessions.result(session, "request_failed", false, "missing file");
    await expect(receipt).resolves.toMatchObject({ outcome: "failed", stage: "ack", dispatched: true });
    expect(sessions.receipt(session, "request_failed")).toMatchObject({ outcome: "failed" });
    expect((await sessions.open(session, "request_failed", target)).outcome).toBe("failed");
    expect(writes).toHaveLength(1);
  });

  it("keeps a lost acknowledgement uncertain and never auto-executes the same identity again", async () => {
    vi.useFakeTimers();
    const receipt = sessions.open(session, "request_lost", target);
    now += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(receipt).resolves.toMatchObject({ outcome: "uncertain", reason: "timeout", dispatched: true });
    expect(sessions.receipt(session, "request_lost")).toMatchObject({ outcome: "uncertain" });
    const duplicate = await sessions.open(session, "request_lost", target);
    expect(duplicate).toMatchObject({ outcome: "uncertain", reason: "timeout" });
    expect(writes).toHaveLength(1);
  });

  it("refines a timed-out receipt from a late authoritative same-session result without resending", async () => {
    vi.useFakeTimers();
    const receipt = sessions.open(session, "request_late_ack", target);
    now += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(receipt).resolves.toMatchObject({ outcome: "uncertain" });
    sessions.result(session, "request_late_ack", true);
    expect(sessions.receipt(session, "request_late_ack")).toMatchObject({ outcome: "opened", stage: "ack", dispatched: true });
    expect((await sessions.open(session, "request_late_ack", target)).outcome).toBe("opened");
    expect(writes).toHaveLength(1);
  });

  it("cancels before dispatch or keeps a written request uncertain; cancelled is false after dispatch", async () => {
    sessions.open(session, "request_cancel", target);
    expect(sessions.cancel(session, "request_cancel")).toBe(false);
    expect(sessions.receipt(session, "request_cancel")).toMatchObject({ outcome: "uncertain", reason: "cancelled", dispatched: true });
    expect(frames().at(-1)).toEqual({ protocol: 2, type: "cancel", requestId: "request_cancel" });
    expect(sessions.cancel(session, "request_cancel")).toBe(false);
    expect((await sessions.open(session, "request_cancel", target)).outcome).toBe("uncertain");
    expect(writes.filter((line) => line.includes("\"openFile\""))).toHaveLength(1);
  });

  it("treats a write throw conservatively as uncertain, never authoritative not-sent", async () => {
    rawSocket.write = () => { throw new Error("broken pipe"); };
    await expect(sessions.open(session, "request_throw", target)).resolves.toMatchObject({
      outcome: "uncertain", dispatched: true, reason: "bridge_unavailable",
    });
  });

  it("returns not-sent only when no socket write was attempted", async () => {
    rawSocket.destroyed = true;
    await expect(sessions.open(session, "request_no_socket", target)).resolves.toMatchObject({
      outcome: "not_sent", dispatched: false, reason: "not_ready",
    });
    // A known-unsent identity remains reserved: a duplicate joins the receipt
    // instead of conflicting or executing once the editor returns.
    await expect(sessions.open(session, "request_no_socket", { ...target })).resolves.toMatchObject({ outcome: "not_sent" });
    expect(writes).toHaveLength(0);
  });

  it("bounds pending dispatch and reports capacity as a reserved not-sent receipt", async () => {
    for (let index = 0; index < 16; index++) sessions.open(session, `request_pending_${index}`, { path: `/file-${index}` });
    await expect(sessions.open(session, "request_overflow", target)).resolves.toMatchObject({ outcome: "not_sent", reason: "capacity", dispatched: false });
    expect(writes).toHaveLength(16);
    expect((await sessions.open(session, "request_overflow", target)).outcome).toBe("not_sent");
    expect(writes).toHaveLength(16);
  });

  it("expires terminal receipts to UNKNOWN and never converts them to not_sent", async () => {
    expect(sessions.receipt(session, "request_missing")).toBeUndefined();
    const receipt = sessions.open(session, "request_expire", target);
    sessions.result(session, "request_expire", true);
    await receipt;
    now += RECEIPT_TTL_MS + 1;
    expect(sessions.receipt(session, "request_expire")).toBeUndefined();
  });

  it("retains non-expired uncertain receipts and rejects new admission instead of evicting them", async () => {
    vi.useFakeTimers();
    let sequence = 0, heartbeat = 2;
    while (sequence < MAX_RECEIPTS) {
      sessions.update(session, heartbeat++, false);
      const batch: Array<Promise<unknown>> = [];
      for (let index = 0; index < 16 && sequence < MAX_RECEIPTS; index++, sequence++) {
        batch.push(sessions.open(session, `request_uncertain_${sequence}`, { path: `/uncertain-${sequence}` }));
      }
      now += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all(batch);
    }
    expect(sessions.receipt(session, "request_uncertain_0")).toMatchObject({ outcome: "uncertain" });
    sessions.update(session, heartbeat, false);
    const before = writes.length;
    await expect(sessions.open(session, "request_after_full", target)).resolves.toMatchObject({
      outcome: "not_sent", reason: "capacity", dispatched: false,
    });
    expect(writes).toHaveLength(before);
    expect(sessions.receipt(session, "request_uncertain_0")).toMatchObject({ outcome: "uncertain" });
  });

  it("presents stage and correlation ID for retained receipts and UNKNOWN for null/expired", () => {
    const receipt = sessions.receipt(session, "request_display") ?? {
      version: 2 as const, correlationId: "request_display", requestId: "request_display",
      stage: "execution" as const, outcome: "uncertain" as const, dispatched: true,
      reason: "timeout" as const, updatedAt: now, expiresAt: now + RECEIPT_TTL_MS,
    };
    const text = describeFileOpenReceipt(receipt);
    expect(text).toContain("Request request_display");
    expect(text).toContain("outcome uncertain");
    expect(text).toContain("stage execution");
    expect(text).toContain("timeout");
    const unknown = describeFileOpenReceipt(null);
    expect(unknown).toContain("Outcome unknown");
    expect(unknown).toContain("does not mean the request was not sent");
    expect(unknown).not.toContain("outcome not_sent");
  });

  it("keeps memory bounded across more receipts than the limit", async () => {
    for (let index = 0; index < MAX_RECEIPTS + 10; index++) {
      const requestId = `request_bounded_${index}`;
      const receipt = sessions.open(session, requestId, { path: `/file-${index}` });
      sessions.result(session, requestId, true);
      await receipt;
      now += 1;
    }
    const oldest = sessions.receipt(session, "request_bounded_0");
    expect(oldest).toBeUndefined();
    expect(sessions.receipt(session, `request_bounded_${MAX_RECEIPTS + 9}`)).toMatchObject({ outcome: "opened" });
  });
});
