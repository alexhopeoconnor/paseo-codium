import type { PluginServerContext } from "@getpaseo/plugin/server";
import { codiumPresentationSettings, codiumSettings } from "./shared/settings";
import {
  cancelRequestRpc, createSessionRpc, openFileRpc, receiptRpc, releaseSessionRpc,
  sessionStateRpc, snapshotRpc,
} from "./shared/rpc";
import { EditorBridge } from "./server/bridge";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(codiumSettings);
  server.registerSettings(codiumPresentationSettings);
  const bridge = new EditorBridge();
  server.handle(createSessionRpc, async (input, { paseo }) => {
    await bridge.ready;
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace?.workspaceDirectory?.startsWith("/")) throw new Error("The workspace directory is unavailable.");
    return bridge.sessions.create(input.workspaceId, input.clientId, workspace.workspaceDirectory, input.presentation);
  });
  // Routine display polling reads only the cached heartbeat state. Close
  // protection uses the separate fresh paired-window snapshot.
  server.handle(sessionStateRpc, async (input) => {
    await bridge.ready;
    return bridge.sessions.state(bridge.sessions.authorize(input.sessionId, input.ownerKey));
  });
  server.handle(snapshotRpc, async (input) => {
    await bridge.ready;
    return bridge.sessions.freshState(bridge.sessions.authorize(input.sessionId, input.ownerKey));
  });
  server.handle(openFileRpc, async (input) => {
    await bridge.ready;
    const receipt = await bridge.sessions.open(bridge.sessions.authorize(input.sessionId, input.ownerKey), input.requestId, input.target);
    return { requestId: input.requestId, receipt };
  });
  server.handle(receiptRpc, async (input) => {
    await bridge.ready;
    return { receipt: bridge.sessions.receipt(bridge.sessions.authorize(input.sessionId, input.ownerKey), input.requestId) ?? null };
  });
  server.handle(cancelRequestRpc, async (input) => {
    await bridge.ready;
    return { cancelled: bridge.sessions.cancel(bridge.sessions.authorize(input.sessionId, input.ownerKey), input.requestId) };
  });
  server.handle(releaseSessionRpc, async (input) => {
    await bridge.ready;
    bridge.sessions.release(bridge.sessions.authorize(input.sessionId, input.ownerKey));
    return { released: true as const };
  });
  return () => bridge.dispose();
}
