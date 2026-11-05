import type { FileTarget } from "../shared/wire";

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
