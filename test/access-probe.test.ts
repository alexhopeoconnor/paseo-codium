import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_PROBE_TIMEOUT_MS, browserAccessEnvironment, newAccessNonce, openAccessHelper,
  probeCodiumAccess, type AccessProbeEnvironment,
} from "../client/access-probe";
import {
  ACCESS_HELPER_PATH, ACCESS_READY_TYPE, ACCESS_READY_VERSION, accessNonceFromFragment,
  accessProbeUrl, acceptAccessReady, parseAccessReadyMessage,
} from "../shared/access";

const origin = "https://codium.example.com";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  const listeners = new Set<(event: { origin: string; source: unknown; data: unknown }) => void>();
  const window = {};
  const frame = { contentWindow: window, remove: vi.fn() };
  const open = vi.fn(() => frame);
  const clearTimeout = vi.fn((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const environment: AccessProbeEnvironment = {
    open,
    listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setTimeout: (listener, delay) => globalThis.setTimeout(listener, delay),
    clearTimeout,
    // 16 bytes of 0xab => 32 lowercase hex characters.
    randomBytes(values) { values.fill(0xab); },
  };
  const send = (data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) => {
    for (const listener of listeners) listener({ origin, source: frame.contentWindow, data, ...overrides });
  };
  return { environment, frame, open, listeners, send, clearTimeout };
}

describe("Codium access helper contract", () => {
  it("uses a fragment nonce that never reaches a proxy log", () => {
    const nonce = newAccessNonce((values) => values.fill(0xab));
    expect(nonce).toBe("ab".repeat(16));
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(accessNonceFromFragment(`#nonce=${nonce}`)).toBe(nonce);
    expect(accessProbeUrl(origin, nonce)).toBe(`${origin}${ACCESS_HELPER_PATH}#nonce=${nonce}`);
    for (const fragment of ["", "#", `#${nonce}`, `#nonce=${nonce}0`, `#nonce=${nonce.toUpperCase()}`]) {
      expect(accessNonceFromFragment(fragment)).toBeUndefined();
    }
  });
  it("accepts only the exact reviewed schema", () => {
    const nonce = "a".repeat(32);
    expect(parseAccessReadyMessage({ type: ACCESS_READY_TYPE, version: ACCESS_READY_VERSION, nonce })).toEqual({
      type: ACCESS_READY_TYPE, version: ACCESS_READY_VERSION, nonce,
    });
    for (const message of [
      { type: ACCESS_READY_TYPE, version: 2, nonce },
      { type: ACCESS_READY_TYPE, version: 1, nonce: nonce.toUpperCase() },
      { type: "other", version: 1, nonce },
      { type: ACCESS_READY_TYPE, version: 1, nonce, extra: true },
      { type: ACCESS_READY_TYPE, version: 1 },
      null, "ready",
    ]) expect(() => parseAccessReadyMessage(message)).toThrow();
  });
  it("checks origin, live iframe window and current nonce together", () => {
    const nonce = "b".repeat(32), source = {};
    const event = { origin, source, data: { type: ACCESS_READY_TYPE, version: 1, nonce } };
    expect(acceptAccessReady(event, { origin, source, nonce })).toBe(true);
    expect(acceptAccessReady({ ...event, origin: "https://evil.example.com" }, { origin, source, nonce })).toBe(false);
    expect(acceptAccessReady({ ...event, source: {} }, { origin, source, nonce })).toBe(false);
    expect(acceptAccessReady(event, { origin, source, nonce: "c".repeat(32) })).toBe(false);
    expect(acceptAccessReady({ ...event, source: null }, { origin, source: null, nonce })).toBe(false);
  });
});

describe("access probe lifecycle", () => {
  it("probes the approved helper URL and settles ready only for the current frame/nonce", async () => {
    const f = fixture();
    const probe = probeCodiumAccess(origin, { environment: f.environment });
    expect(probe.nonce).toBe("ab".repeat(16));
    expect(f.open).toHaveBeenCalledWith(`${origin}${ACCESS_HELPER_PATH}#nonce=${probe.nonce}`);
    f.send({ type: ACCESS_READY_TYPE, version: 1, nonce: probe.nonce });
    await expect(probe.result).resolves.toBe("ready");
    expect(f.frame.remove).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    expect(f.clearTimeout).toHaveBeenCalledOnce();
  });
  it("ignores a wrong origin, window, version, schema or nonce and times out unconfirmed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const probe = probeCodiumAccess(origin, { environment: f.environment, timeoutMs: 1000 });
    const ready = { type: ACCESS_READY_TYPE, version: 1, nonce: probe.nonce };
    f.send(ready, { origin: "https://evil.example.com" });
    f.send(ready, { source: {} });
    f.send({ ...ready, version: 2 });
    f.send({ ...ready, nonce: "c".repeat(32) });
    f.send({ ...ready, extra: "unreviewed" });
    expect(f.frame.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(probe.result).resolves.toBe("timeout");
    expect(f.frame.remove).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });
  it("cancels cleanly and ignores a late ready message", async () => {
    const f = fixture();
    const probe = probeCodiumAccess(origin, { environment: f.environment });
    probe.cancel();
    probe.cancel();
    f.send({ type: ACCESS_READY_TYPE, version: 1, nonce: probe.nonce });
    await expect(probe.result).resolves.toBe("cancelled");
    expect(f.frame.remove).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });
  it("fills the production adapter nonce from the platform CSPRNG, not zeros", () => {
    const fill = new Uint8Array(16).fill(0x5a);
    const getRandomValues = vi.fn((values: Uint8Array) => { values.set(fill); return values; });
    vi.stubGlobal("crypto", { getRandomValues });
    const values = new Uint8Array(16);
    browserAccessEnvironment().randomBytes(values);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect([...values]).toEqual([...fill]);
    expect(values.some((value) => value !== 0)).toBe(true);
  });
  it("uses the reviewed eight-second probe budget by default", () => {
    expect(ACCESS_PROBE_TIMEOUT_MS).toBe(8000);
  });
  it("opens the helper page, never the IDE root, with noopener/noreferrer", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    openAccessHelper("https://codium.example.com/");
    expect(open).toHaveBeenCalledWith(`${origin}${ACCESS_HELPER_PATH}`, "_blank", "noopener,noreferrer");
    expect(open).not.toHaveBeenCalledWith(`${origin}/`, expect.anything(), expect.anything());
  });
});
