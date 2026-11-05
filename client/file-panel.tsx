import { useSettings, useWorkspace, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { CodiumTargetPanel } from "./target-panel";
import type { FileTarget } from "../shared/wire";
import { codiumSettings } from "../shared/settings";
import { forwardFileNavigation } from "./editor-session";
import { EMBEDDING_AVAILABLE } from "./features";
import { browserDocumentEpoch, makeCodiumUrl, observePanelVisibility, panelHasVisibleBounds, resolveWorkspaceFile } from "./web";

export function CodiumFilePanel(props: PluginFilePanelProps & { openSettings(): void; openEditor(target: FileTarget): void }) {
  const settings = useSettings(codiumSettings);
  const folder = useWorkspace(props.workspaceId, (workspace) => workspace.directory);
  const panel = useRef<View | null>(null);
  const latest = useRef(props); latest.current = props;
  const [visible, setVisible] = useState(false);
  const [navigationMessage, setNavigationMessage] = useState("");
  const target = { path: props.file.path, line: props.params.lineStart, lineEnd: props.params.lineEnd };
  const path = target.path, line = target.line, lineEnd = target.lineEnd;
  const origin = settings.status === "ready" ? settings.values.codiumBaseUrl : "";
  const mode = settings.status === "ready" ? settings.values.openMode : "external";
  useEffect(() => {
    if (Platform.OS !== "web") return;
    return observePanelVisibility(panel.current, setVisible);
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web" || settings.status === "loading" || !folder) return;
    const current = latest.current;
    let resolved: FileTarget;
    try { resolved = { path: resolveWorkspaceFile(folder, path), line, lineEnd }; }
    catch { return; } // The fallback card displays invalid path errors.
    let enabled = EMBEDDING_AVAILABLE && settings.status === "ready" && mode === "embedded" && !!origin;
    try { if (enabled) makeCodiumUrl(origin, folder, resolved); } catch { enabled = false; }
    const result = forwardFileNavigation({
      documentEpoch: browserDocumentEpoch(), revision: current.revision,
      targetKey: JSON.stringify([current.host.id, current.workspaceId, resolved.path, line, lineEnd]),
      // Recheck synchronous geometry before dispatch, even if the observer has
      // not delivered a newly hidden panel's intersection update yet.
      visible: visible && panelHasVisibleBounds(panel.current), enabled, state: current.tab.state,
      writeState: current.tab.setState as (state: Record<string, unknown>) => void,
      open: () => current.openEditor(resolved),
    });
    if (result === "failed") setNavigationMessage("The file could not be sent to VSCodium. Use Open in VSCodium tab to retry.");
    else if (result === "sent") setNavigationMessage("");
  }, [settings.status, folder, path, line, lineEnd, origin, mode, visible, props.revision, props.host.id, props.workspaceId]);
  return <View ref={panel} style={{ flex: 1 }}>
    <CodiumTargetPanel {...props} target={target} navigationMessage={navigationMessage} />
  </View>;
}
