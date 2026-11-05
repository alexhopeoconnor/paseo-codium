import { useSettings, useWorkspace, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, ExternalLink } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { codiumSettings } from "../shared/settings";
import { EMBEDDING_AVAILABLE } from "./features";
import { makeCodiumUrl, resolveWorkspaceFile, type FileTarget } from "./web";

interface TargetPanelProps extends PluginSurfaceProps {
  workspaceId: string;
  target: FileTarget;
  openSettings(): void;
  openEditor(target: FileTarget): void;
  navigationMessage?: string;
}

/** File actions stay available without taking the place of the file's contents. */
export function CodiumTargetPanel(props: TargetPanelProps) {
  const settings = useSettings(codiumSettings);
  const folder = useWorkspace(props.workspaceId, (workspace) => workspace.directory);
  const [actionMessage, setActionMessage] = useState("");
  const { colors } = props.theme;
  let url = "", problem = "", target = props.target;
  if (settings.status === "loading") problem = "Loading VSCodium connection…";
  else if (settings.status !== "ready") problem = settings.error;
  else if (!settings.values.codiumBaseUrl) problem = "Set a VSCodium address in Settings to open the editor.";
  else if (!folder) problem = "The workspace directory is not available yet.";
  else {
    try {
      target = { ...props.target, path: resolveWorkspaceFile(folder, props.target.path) };
      url = makeCodiumUrl(settings.values.codiumBaseUrl, folder, target);
    } catch (error) { problem = messageOf(error); }
  }
  const embedded = !!url && EMBEDDING_AVAILABLE && Platform.OS === "web" &&
    settings.status === "ready" && settings.values.openMode === "embedded";

  return <View style={{ backgroundColor: colors.surface0, paddingHorizontal: 14, paddingVertical: 10, gap: 8 }} testID="codium-panel">
    <Text selectable numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }} testID="codium-file">
      {target.path}{target.line ? `:${target.line}` : ""}
    </Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 18 }}>
      {embedded ? <Pressable accessibilityRole="button" testID="codium-open-tab" onPress={() => {
        try { props.openEditor(target); setActionMessage(""); }
        catch { setActionMessage("The editor could not accept this request. Try again after it connects."); }
      }}>
        <Text style={{ color: colors.accent, fontWeight: "600" }}>Open in VSCodium tab</Text>
      </Pressable> : null}
      {url ? <>
        <ExternalLink href={url} testID="codium-open" onError={(error) => setActionMessage(messageOf(error))}>
          <Text style={{ color: embedded ? colors.foregroundMuted : colors.accent }}>Open in browser</Text>
        </ExternalLink>
        <Pressable accessibilityRole="button" onPress={() => {
          void copyText(url).then(() => setActionMessage("Link copied."), (error: unknown) => setActionMessage(messageOf(error)));
        }}>
          <Text style={{ color: colors.foregroundMuted }}>Copy link</Text>
        </Pressable>
      </> : null}
      <Pressable accessibilityRole="button" onPress={props.openSettings}>
        <Text style={{ color: colors.foregroundMuted }}>Settings</Text>
      </Pressable>
    </View>
    {problem || actionMessage ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12 }}>{problem || actionMessage}</Text> : null}
    {props.navigationMessage ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger, fontSize: 12 }}>{props.navigationMessage}</Text> : null}
    {url && target.path.includes(":") && target.line ?
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Browser links open colon-containing filenames without a line jump.</Text> : null}
  </View>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
