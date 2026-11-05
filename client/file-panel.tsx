import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { CodiumTargetPanel } from "./target-panel";
import type { FileTarget } from "../shared/wire";

export function CodiumFilePanel(props: PluginFilePanelProps & { openSettings(): void; openEditor(target: FileTarget): void }) {
  const target = { path: props.file.path, line: props.params.lineStart, lineEnd: props.params.lineEnd };
  return <CodiumTargetPanel {...props} target={target} />;
}
