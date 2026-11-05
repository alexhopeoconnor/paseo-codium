import { useSettings, useWorkspace, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, Icon, Loading } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { codiumSettings } from "../shared/settings";
import { EMBEDDING_AVAILABLE } from "./features";
import { makeCodiumUrl, resolveWorkspaceFile, type FileTarget } from "./web";

interface TargetPanelProps extends PluginSurfaceProps {
  workspaceId: string;
  revision: number;
  target?: FileTarget;
  openSettings(): void;
  openEditor?(target: FileTarget): void;
}

export function CodiumTargetPanel(props: TargetPanelProps) {
  const settings = useSettings(codiumSettings);
  const folder = useWorkspace(props.workspaceId, (workspace) => workspace.directory);
  const [actionMessage, setActionMessage] = useState("");
  const { theme } = props;
  const colors = theme.colors;

  if (settings.status === "loading") return <Loading />;
  if (settings.status !== "ready") return <Message {...props} text={settings.error} />;
  if (!settings.values.codiumBaseUrl) {
    return <Message {...props} text="Set your VSCodium Web address to open this workspace." />;
  }
  if (!folder) return <Message {...props} text="The workspace directory is not available yet." />;

  let url: string;
  let target: FileTarget | undefined;
  try {
    target = props.target ? { ...props.target, path: resolveWorkspaceFile(folder, props.target.path) } : undefined;
    url = makeCodiumUrl(settings.values.codiumBaseUrl, folder, target);
  }
  catch (error) { return <Message {...props} text={messageOf(error)} />; }
  const openEditor = EMBEDDING_AVAILABLE && Platform.OS === "web" && settings.values.openMode === "embedded"
    ? props.openEditor : undefined;
  const opensEditorTab = !!openEditor && !!target;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }} testID="codium-panel">
      <View style={{ padding: 24, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name="Code" size={22} color={colors.accent} />
          <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>VSCodium</Text>
        </View>
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: 13 }} testID="codium-folder">{folder}</Text>
        {target ? (
          <Text selectable style={{ color: colors.foreground, fontSize: 14 }} testID="codium-file">
            {target.path}{target.line ? `:${target.line}` : ""}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 18 }}>
          {opensEditorTab ? <Pressable accessibilityRole="button" testID="codium-open-tab" onPress={() => {
            try { if (openEditor && target) openEditor(target); setActionMessage(""); }
            catch { setActionMessage("The editor could not accept this request. Try again after it connects."); }
          }}>
            <Text style={{ color: colors.accent, fontSize: 15, fontWeight: "600" }}>Open in VSCodium tab</Text>
          </Pressable> : null}
          <ExternalLink href={url} testID="codium-open" onError={(error) => setActionMessage(messageOf(error))}>
            <Text style={{ color: opensEditorTab ? colors.foregroundMuted : colors.accent, fontSize: opensEditorTab ? 14 : 15, fontWeight: opensEditorTab ? "400" : "600" }}>
              {opensEditorTab ? "Open in browser" : props.target ? "Open file in VSCodium" : "Open workspace in VSCodium"}
            </Text>
          </ExternalLink>
          <Pressable accessibilityRole="button" onPress={() => {
            void copyText(url).then(() => setActionMessage("Link copied."), (error: unknown) => setActionMessage(messageOf(error)));
          }}>
            <Text style={{ color: colors.foregroundMuted }}>{opensEditorTab ? "Copy browser link" : "Copy link"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={props.openSettings}>
            <Text style={{ color: colors.foregroundMuted }}>Settings</Text>
          </Pressable>
        </View>
        {actionMessage ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted }}>{actionMessage}</Text> : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          {opensEditorTab ? "Opens this file in the workspace’s VSCodium tab in Paseo." : "Opens the files on this host in your browser."}
        </Text>
        {target?.path.includes(":") && target.line ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>This filename contains a colon, so the browser link opens the file without jumping to a line.</Text>
        ) : null}
      </View>
    </View>
  );
}

function Message({ text, theme, openSettings }: Pick<TargetPanelProps, "theme" | "openSettings"> & { text: string }) {
  return (
    <View style={{ padding: 24, gap: 16 }}>
      <Text style={{ color: theme.colors.foreground }}>{text}</Text>
      <Pressable accessibilityRole="button" onPress={openSettings}>
        <Text style={{ color: theme.colors.accent }}>VSCodium settings</Text>
      </Pressable>
    </View>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
