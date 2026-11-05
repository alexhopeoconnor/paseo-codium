import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { CodiumTargetPanel } from "./target-panel";

export function CodiumWorkspacePanel(props: PluginWorkspacePanelProps & { openSettings(): void }) {
  return <CodiumTargetPanel {...props} />;
}
