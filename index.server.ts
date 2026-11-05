import type { PluginServerContext } from "@getpaseo/plugin/server";
import { codiumSettings } from "./shared/settings";
import { createSessionRpc, openFileRpc, releaseSessionRpc, sessionStateRpc } from "./shared/rpc";
import { EditorBridge } from "./server/bridge";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(codiumSettings);
  const bridge = new EditorBridge();
  server.handle(createSessionRpc, async (input, { paseo }) => {
    await bridge.ready;
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace?.workspaceDirectory?.startsWith("/")) throw new Error("The workspace directory is unavailable.");
    return bridge.sessions.create(input.workspaceId, input.clientId, workspace.workspaceDirectory);
  });
  server.handle(sessionStateRpc, async (input) => {
    await bridge.ready;
    return bridge.sessions.freshState(bridge.sessions.authorize(input.sessionId, input.ownerKey));
  });
  server.handle(openFileRpc, async (input) => {
    await bridge.ready;
    await bridge.sessions.open(bridge.sessions.authorize(input.sessionId, input.ownerKey), input.requestId, input.target);
    return { requestId: input.requestId, opened: true as const };
  });
  server.handle(releaseSessionRpc, async (input) => {
    await bridge.ready;
    bridge.sessions.release(bridge.sessions.authorize(input.sessionId, input.ownerKey));
    return { released: true as const };
  });
  return () => bridge.dispose();
}
