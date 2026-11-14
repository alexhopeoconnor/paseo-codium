import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { codiumSettings, connectionSchema } from "../shared/settings";
import type { FileOpenReason } from "../shared/receipts";
import { identifier, validTarget } from "../shared/wire";
import { editorConnectionKey, editorQueue, editorReceipts } from "./editor-session";
import {
  openPanelOptions, readHostCapabilities, type ConfirmedFileOpenContext, type ConfirmedFileOpenResult,
  type FileOpenSignal,
} from "./host-capabilities";
import { makeCodiumUrl, resolveWorkspaceFile } from "./web";

interface OpenReceipt { result: Promise<ConfirmedFileOpenResult>; settled: boolean; fingerprint: string }
const MAX_OPEN_RECEIPTS = 1024;

function requestFingerprint(request: ConfirmedFileOpenContext): string {
  return JSON.stringify([request.workspaceDirectory, request.path, request.lineStart ?? null, request.lineEnd ?? null]);
}

/** Called by a capable host only after the viewer choice has been confirmed. */
export function createConfirmedFileOpener(client: PluginClientContext) {
  const capabilities = readHostCapabilities(client);
  // The host may share one cancellation lifetime across a workspace's requests.
  // Bound recent receipts and release them with that lifetime; in-flight requests
  // are never evicted and cannot dispatch twice during asynchronous resolution.
  const requests = new WeakMap<FileOpenSignal, Map<string, OpenReceipt>>();
  async function dispatch(request: ConfirmedFileOpenContext): Promise<ConfirmedFileOpenResult> {
    const requestId = request.requestId;
    let started = editorReceipts.begin(requestId, "host_route");
    if (started.outcome === "not_sent") {
      // A retained not-sent receipt is known unsent: an explicit host retry may
      // reuse the original identity. Capacity (unretained) stays a fallback.
      started = editorReceipts.retry(requestId);
    }
    if (started.outcome === "not_sent") {
      // Admission was refused before routing. Let the host keep its existing
      // rendered fallback rather than leaving an untracked request.
      return "render";
    }
    if (started.outcome === "opened" || started.outcome === "failed" || started.outcome === "uncertain") {
      // This identity already reached the editor. Do not re-dispatch or open a
      // second viewer; the receipt remains queryable.
      return "handled";
    }
    const notSent = (stage: "host_route" | "queue", reason: FileOpenReason) =>
      editorReceipts.advance(requestId, stage, "not_sent", reason);
    const cancelled = () => {
      if (!request.signal.aborted) return;
      notSent("host_route", "cancelled");
      const error = new Error("The file-open request was cancelled.");
      error.name = "AbortError";
      throw error;
    };
    cancelled();
    if (request.platform !== "web") { notSent("host_route", "fallback"); return "render"; }
    const settings = await client.rpc(settingsRpc(codiumSettings.id).read, {});
    cancelled();
    if (settings.status !== "ready") { notSent("host_route", "fallback"); return "render"; }
    const parsed = connectionSchema.safeParse(settings.values);
    if (!parsed.success || parsed.data.openMode !== "embedded" || !parsed.data.codiumBaseUrl) {
      notSent("host_route", "fallback");
      return "render";
    }
    let workspaceDirectory: string | undefined;
    try {
      workspaceDirectory = (await client.paseo.workspaces.ref(request.workspaceId).refresh())?.workspaceDirectory;
    } catch (error) {
      notSent("host_route", "invalid");
      throw error;
    }
    cancelled();
    if (!workspaceDirectory) { notSent("host_route", "invalid"); throw new Error("The workspace directory is no longer available."); }
    if (workspaceDirectory !== request.workspaceDirectory) {
      notSent("host_route", "invalid");
      throw new Error("The workspace directory changed. Open the file again.");
    }
    const target = {
      path: resolveWorkspaceFile(workspaceDirectory, request.path),
      line: request.lineStart,
      lineEnd: request.lineEnd,
    };
    if (!identifier(requestId) || !validTarget(target)) { notSent("host_route", "invalid"); throw new Error("The file-open request is invalid."); }
    try { makeCodiumUrl(parsed.data.codiumBaseUrl, workspaceDirectory, target); }
    catch (error) { notSent("host_route", "invalid"); throw error; }
    cancelled();
    try {
      editorQueue(request.hostId, request.workspaceId).route({
        requestId,
        connectionKey: editorConnectionKey(parsed.data),
        target,
        signal: request.signal,
      }, () => client.openPanel("codium", openPanelOptions(capabilities, request.workspaceId, requestId)));
    } catch (error) {
      notSent("queue", /Too many queued files/.test(String((error as Error).message)) ? "capacity" : "bridge_unavailable");
      throw error;
    }
    return "handled";
  }
  return (request: ConfirmedFileOpenContext): Promise<ConfirmedFileOpenResult> => {
    if (request.signal.aborted) {
      editorReceipts.begin(request.requestId, "host_route");
      editorReceipts.advance(request.requestId, "host_route", "not_sent", "cancelled");
      const error = new Error("The file-open request was cancelled.");
      error.name = "AbortError";
      throw error;
    }
    let owned = requests.get(request.signal);
    if (!owned) { owned = new Map(); requests.set(request.signal, owned); }
    const key = JSON.stringify([request.hostId, request.workspaceId, request.requestId]);
    const fingerprint = requestFingerprint(request);
    const previous = owned.get(key);
    if (previous) {
      // A host request identity names one target. Never let a conflicting reuse
      // join the earlier operation or silently claim success.
      if (previous.fingerprint !== fingerprint) throw new Error("The file-open request identifier was reused for a different file.");
      return previous.result;
    }
    if (owned.size >= MAX_OPEN_RECEIPTS) {
      const disposable = [...owned].find(([, receipt]) => receipt.settled);
      if (!disposable) {
        editorReceipts.begin(request.requestId, "host_route");
        editorReceipts.advance(request.requestId, "host_route", "not_sent", "capacity");
        throw new Error("Too many pending file-open requests. Wait for the editor to connect.");
      }
      owned.delete(disposable[0]);
    }
    const result = dispatch(request);
    const receipt = { result, settled: false, fingerprint };
    owned.set(key, receipt);
    void result.then(() => { receipt.settled = true; }, () => { receipt.settled = true; });
    return result;
  };
}
