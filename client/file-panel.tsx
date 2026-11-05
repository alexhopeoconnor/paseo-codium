import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { CodiumTargetPanel } from "./target-panel";

export function CodiumFilePanel(props: PluginFilePanelProps & { openSettings(): void }) {
  return <CodiumTargetPanel {...props} target={{ path: props.params.path, line: props.params.lineStart }} />;
}
