import type { FileTarget } from "../shared/wire";

interface FileNavigationStamp {
  documentEpoch: number;
  revision: number;
  targetKey: string;
  outcome: "attempted" | "sent" | "skipped" | "failed";
}
interface FileNavigationInput {
  documentEpoch: number;
  revision: number;
  targetKey: string;
  visible: boolean;
  enabled: boolean;
  state: unknown;
  writeState(state: Record<string, unknown>): void;
  open(): void;
}
const navigationClaims = new WeakMap<FileNavigationInput["writeState"], string>();

/** Host revision increments for a file-open intent, but stays unchanged on remount. */
export function forwardFileNavigation(input: FileNavigationInput): "unchanged" | "sent" | "skipped" | "failed" {
  if (!Number.isFinite(input.documentEpoch) || input.documentEpoch <= 0 ||
      !Number.isSafeInteger(input.revision) || input.revision <= 0 || (input.enabled && !input.visible)) return "unchanged";
  const state = typeof input.state === "object" && input.state !== null && !Array.isArray(input.state)
    ? input.state as Record<string, unknown>
    : input.state === undefined ? {} : { previousPanelState: input.state };
  const stamp: FileNavigationStamp = {
    documentEpoch: input.documentEpoch, revision: input.revision, targetKey: input.targetKey, outcome: "attempted",
  };
  const key = JSON.stringify([stamp.documentEpoch, stamp.revision, stamp.targetKey]);
  const previous = state.codiumFileNavigation as Partial<FileNavigationStamp> | undefined;
  if (navigationClaims.get(input.writeState) === key || (previous?.documentEpoch === stamp.documentEpoch &&
      previous.revision === stamp.revision && previous.targetKey === stamp.targetKey)) return "unchanged";
  // Claim before dispatch: StrictMode, settings writes and synchronous host renders
  // cannot enqueue twice. Persist the attempt so plugin reload also cannot replay it.
  navigationClaims.set(input.writeState, key);
  try {
    input.writeState({ ...state, codiumFileNavigation: stamp });
    if (input.enabled) input.open();
    const outcome = input.enabled ? "sent" : "skipped";
    input.writeState({ ...state, codiumFileNavigation: { ...stamp, outcome } });
    return outcome;
  } catch {
    try { input.writeState({ ...state, codiumFileNavigation: { ...stamp, outcome: "failed" } }); } catch { /* Memory claim still prevents a retry loop. */ }
    return "failed";
  }
}

export function shouldProtectEditor(state: { dirty: boolean; known: boolean }, frameFocused: boolean, observedEpoch: number, currentEpoch: number): boolean {
  return state.dirty || !state.known || frameFocused || observedEpoch !== currentEpoch;
}

export interface FileRequest { requestId: string; target: FileTarget }
/** Registry lives in this client runtime, never in shared host settings. */
export class EditorQueue {
  private requests: FileRequest[] = [];
  private listeners = new Set<() => void>();
  lastTarget?: FileTarget;
  enqueue(request: FileRequest) {
    if (this.requests.some((entry) => entry.requestId === request.requestId)) return;
    if (this.requests.length >= 32) throw new Error("Too many queued files. Wait for the editor to connect.");
    this.requests.push(request);
    for (const listener of this.listeners) listener();
  }
  route(request: FileRequest, openPanel: () => void) {
    if (this.requests.length >= 32) throw new Error("Too many queued files. Wait for the editor to connect.");
    // A connected editor drains synchronously on enqueue notification. Route
    // first so a failing host focus operation cannot send a file command.
    openPanel();
    this.enqueue(request);
  }
  peek() { return this.requests[0]; }
  complete(requestId: string, opened: boolean) {
    const first = this.requests[0];
    if (first?.requestId !== requestId) return;
    this.requests.shift();
    if (opened) this.lastTarget = first.target;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
const queues = new Map<string, EditorQueue>();
export function editorQueue(hostId: string, workspaceId: string): EditorQueue {
  const key = JSON.stringify([hostId, workspaceId]);
  let queue = queues.get(key);
  if (!queue) { queue = new EditorQueue(); queues.set(key, queue); }
  return queue;
}
export function clearEditorQueues() { queues.clear(); }
