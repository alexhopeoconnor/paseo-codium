import { useSettings, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ExternalLink, Loading } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { codiumSettings } from "../shared/settings";
import { EMBEDDING_AVAILABLE } from "./features";
import { EmbeddedEditor } from "./embedded-editor";
import { makeCodiumUrl } from "./web";

type Connection = { codiumBaseUrl: string; openMode: "external" | "embedded" };

export function CodiumWorkspacePanel(props: PluginWorkspacePanelProps & { openSettings(): void }) {
  const settings = useSettings(codiumSettings);
  const directory = useWorkspace(props.workspaceId, (workspace) => workspace.directory);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [protectedEditor, setProtectedEditor] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);
  useEffect(() => { if (!connection && settings.status === "ready") setConnection(settings.values); }, [connection, settings]);
  if (!connection) return settings.status === "loading" || settings.status === "ready" ? <Loading /> :
    <Text style={{ padding: 20, color: props.theme.colors.statusDanger }}>Connection settings are unavailable.</Text>;
  const { colors } = props.theme;
  const changed = settings.status === "ready" && JSON.stringify(connection) !== JSON.stringify(settings.values);
  const embedded = EMBEDDING_AVAILABLE && Platform.OS === "web" && connection.openMode === "embedded" && !!connection.codiumBaseUrl;
  let externalUrl = "";
  try { if (directory && connection.codiumBaseUrl) externalUrl = makeCodiumUrl(connection.codiumBaseUrl, directory); } catch { /* Display configuration action below. */ }
  const apply = () => { if (settings.status === "ready") {
    // Called only after a known-clean transition or an explicit discard choice.
    props.tab.setModified(false); setConnection(settings.values); setConfirmChange(false); setProtectedEditor(false);
  } };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ padding: embedded ? 10 : 24, gap: 12 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 20 }}>
          <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 17 }}>VSCodium</Text>
          {externalUrl ? <ExternalLink href={externalUrl}><Text style={{ color: colors.accent }}>Open in browser</Text></ExternalLink> : null}
          <Pressable accessibilityRole="button" onPress={props.openSettings}><Text style={{ color: colors.foregroundMuted }}>Settings</Text></Pressable>
        </View>
        {!embedded ? <Text selectable style={{ color: colors.foregroundMuted }}>{directory || "Workspace directory unavailable"}</Text> : null}
        {!externalUrl ? <Text style={{ color: colors.foregroundMuted }}>Set a VSCodium HTTPS address and select a workspace to open the editor.</Text> : null}
        {changed ? <Pressable accessibilityRole="button" onPress={() => protectedEditor ? setConfirmChange(true) : apply()}><Text style={{ color: colors.accent }}>Apply changed connection settings</Text></Pressable> : null}
        {confirmChange ? <View style={{ gap: 10 }}>
          <Text style={{ color: colors.foreground }}>Changing the connection closes this editor. Unsaved changes may be lost.</Text>
          <View style={{ flexDirection: "row", gap: 20 }}>
            <Pressable accessibilityRole="button" onPress={() => setConfirmChange(false)}><Text style={{ color: colors.accent }}>Keep editing</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={apply}><Text style={{ color: colors.statusDanger }}>Change connection anyway</Text></Pressable>
          </View>
        </View> : null}
      </View>
      {embedded && directory ? <EmbeddedEditor {...props} origin={connection.codiumBaseUrl} onProtectedChange={setProtectedEditor} /> : null}
    </View>
  );
}
