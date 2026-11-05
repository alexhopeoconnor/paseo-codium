import { useSettings, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { CodiumTargetPanel } from "./target-panel";
import { Platform, Pressable, Text, View } from "react-native";
import { useState } from "react";
import type { FileTarget } from "../shared/wire";
import { codiumSettings } from "../shared/settings";

export function CodiumFilePanel(props: PluginFilePanelProps & { openSettings(): void; openEditor(target: FileTarget): void }) {
  const [error, setError] = useState("");
  const settings = useSettings(codiumSettings);
  const target = { path: props.file.path, line: props.params.lineStart, lineEnd: props.params.lineEnd };
  return <View style={{ flex: 1 }}>
    {Platform.OS === "web" && settings.status === "ready" && settings.values.openMode === "embedded" ? <View style={{ padding: 20, gap: 10 }}>
      <Pressable accessibilityRole="button" onPress={() => { try { props.openEditor(target); setError(""); } catch { setError("The editor could not accept this request. Try again after it connects."); } }}>
        <Text style={{ color: props.theme.colors.accent, fontWeight: "600" }}>Open in workspace editor</Text>
      </Pressable>
      {error ? <Text style={{ color: props.theme.colors.statusDanger }}>{error}</Text> : null}
    </View> : null}
    <CodiumTargetPanel {...props} target={target} />
  </View>;
}
