import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { codiumSettings, connectionSchema } from "../shared/settings";
import { identifier, validTarget } from "../shared/wire";
import { editorConnectionKey, editorQueue } from "./editor-session";
import type { ConfirmedFileOpenContext, ConfirmedFileOpenResult, FileOpenSignal } from "./host-capabilities";
import { makeCodiumUrl, resolveWorkspaceFile } from "./web";

interface OpenReceipt { result: Promise<ConfirmedFileOpenResult>; settled: boolean }
const MAX_OPEN_RECEIPTS = 1024;

function checkCancelled(signal: FileOpenSignal) {
  if (signal.aborted) {
    const error = new Error("The file-open request was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

/** Called by a capable host only after the viewer choice has been confirmed. */
export function createConfirmedFileOpener(client: PluginClientContext) {
  // The host may share one cancellation lifetime across a workspace's requests.
  // Bound recent receipts and release them with that lifetime; in-flight requests
  // are never evicted and cannot dispatch twice during asynchronous resolution.
  const requests = new WeakMap<FileOpenSignal, Map<string, OpenReceipt>>();
  async function dispatch(request: ConfirmedFileOpenContext): Promise<ConfirmedFileOpenResult> {
    checkCancelled(request.signal);
    if (request.platform !== "web") return "render";
    const settings = await client.rpc(settingsRpc(codiumSettings.id).read, {});
    checkCancelled(request.signal);
    if (settings.status !== "ready") return "render";
    const parsed = connectionSchema.safeParse(settings.values);
    if (!parsed.success || parsed.data.openMode !== "embedded" || !parsed.data.codiumBaseUrl) return "render";
    const workspace = await client.paseo.workspaces.ref(request.workspaceId).refresh();
    checkCancelled(request.signal);
    if (!workspace?.workspaceDirectory) throw new Error("The workspace directory is no longer available.");
    if (workspace.workspaceDirectory !== request.workspaceDirectory) throw new Error("The workspace directory changed. Open the file again.");
    const target = {
      path: resolveWorkspaceFile(workspace.workspaceDirectory, request.path),
      line: request.lineStart,
      lineEnd: request.lineEnd,
    };
    if (!identifier(request.requestId) || !validTarget(target)) throw new Error("The file-open request is invalid.");
    makeCodiumUrl(parsed.data.codiumBaseUrl, workspace.workspaceDirectory, target);
    checkCancelled(request.signal);
    editorQueue(request.hostId, request.workspaceId).route({
      requestId: request.requestId,
      connectionKey: editorConnectionKey(parsed.data),
      target,
      signal: request.signal,
    }, () => client.openPanel("codium", { workspaceId: request.workspaceId }));
    return "handled";
  }
  return (request: ConfirmedFileOpenContext): Promise<ConfirmedFileOpenResult> => {
    checkCancelled(request.signal);
    let owned = requests.get(request.signal);
    if (!owned) { owned = new Map(); requests.set(request.signal, owned); }
    const key = JSON.stringify([request.hostId, request.workspaceId, request.requestId]);
    const previous = owned.get(key);
    if (previous) return previous.result;
    if (owned.size >= MAX_OPEN_RECEIPTS) {
      const disposable = [...owned].find(([, receipt]) => receipt.settled);
      if (!disposable) throw new Error("Too many pending file-open requests. Wait for the editor to connect.");
      owned.delete(disposable[0]);
    }
    const result = dispatch(request);
    const receipt = { result, settled: false };
    owned.set(key, receipt);
    void result.then(() => { receipt.settled = true; }, () => { receipt.settled = true; });
    return result;
  };
}
