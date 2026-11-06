import { useSettings, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { codiumSettings } from "../shared/settings";
import { EmbeddedEditor } from "./embedded-editor";
import { makeCodiumUrl } from "./web";
import { editorConnectionKey, editorQueue, type EditorConnection } from "./editor-session";
import { EditorToolbar } from "./editor-toolbar";
import type { CloseProtectionResolver } from "./host-capabilities";

export function CodiumWorkspacePanel(props: PluginWorkspacePanelProps & { retainEditor: boolean; freshCloseProtection: boolean; openSettings(): void }) {
  const settings = useSettings(codiumSettings);
  const directory = useWorkspace(props.workspaceId, (workspace) => workspace.directory);
  const [connection, setConnection] = useState<EditorConnection | null>(null);
  const [protectedEditor, setProtectedEditor] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);
  const [checkingChange, setCheckingChange] = useState(false);
  const [error, setError] = useState("");
  const beforeClose = useRef<CloseProtectionResolver | null>(null);
  const setBeforeCloseResolver = useCallback((resolver: CloseProtectionResolver | null) => { beforeClose.current = resolver; }, []);
  useEffect(() => { if (!connection && settings.status === "ready") setConnection(settings.values); }, [connection, settings]);
  if (!connection) return settings.status === "loading" || settings.status === "ready" ? <Loading /> :
    <Text style={{ padding: 20, color: props.theme.colors.statusDanger }}>Connection settings are unavailable.</Text>;
  const { colors } = props.theme;
  const changed = settings.status === "ready" && JSON.stringify(connection) !== JSON.stringify(settings.values);
  const embedded = Platform.OS === "web" && connection.openMode === "embedded" && !!connection.codiumBaseUrl && !!directory;
  let externalUrl = "";
  try { if (directory && connection.codiumBaseUrl) externalUrl = makeCodiumUrl(connection.codiumBaseUrl, directory); } catch { /* Display configuration action below. */ }
  const apply = () => { if (settings.status === "ready") {
    // Called only after a known-clean transition or an explicit discard choice.
    editorQueue(props.host.id, props.workspaceId).discardOtherConnections(editorConnectionKey(settings.values));
    props.tab.setModified(false); setConnection(settings.values); setConfirmChange(false); setProtectedEditor(false);
  } };
  const requestChange = async () => {
    if (checkingChange) return;
    const resolver = beforeClose.current;
    setCheckingChange(true);
    let protectedNow = embedded || protectedEditor;
    try { if (resolver) protectedNow = await resolver(); } catch { protectedNow = true; }
    setCheckingChange(false);
    if (beforeClose.current !== resolver) return;
    if (protectedNow) setConfirmChange(true); else apply();
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      {!embedded ? <EditorToolbar theme={props.theme} externalUrl={externalUrl} connection={{ kind: "external", message: "External browser mode" }} openSettings={props.openSettings} onError={setError} /> : null}
      {!embedded || changed || confirmChange ? <View style={{ padding: embedded ? 10 : 24, gap: 12 }}>
        {!embedded ? <Text selectable style={{ color: colors.foregroundMuted }}>{directory || "Workspace directory unavailable"}</Text> : null}
        {!externalUrl ? <Text style={{ color: colors.foregroundMuted }}>Set a VSCodium HTTPS address and select a workspace to open the editor.</Text> : null}
        {error ? <Text style={{ color: colors.statusDanger }}>{error}</Text> : null}
        {changed ? <View style={{ gap: 8 }}>
          <Text testID="codium-connection-pending" style={{ color: colors.foregroundMuted, fontSize: 12 }}>New file requests wait until you apply the changed connection settings. The current editor keeps its existing connection.</Text>
          <Pressable testID="codium-connection-apply" accessibilityRole="button" disabled={checkingChange} accessibilityState={{ busy: checkingChange }} onPress={() => { void requestChange(); }}><Text style={{ color: colors.accent }}>{checkingChange ? "Checking editor…" : "Apply changed connection settings"}</Text></Pressable>
        </View> : null}
        {confirmChange ? <View style={{ gap: 10 }}>
          <Text style={{ color: colors.foreground }}>Changing the connection closes this editor. Unsaved changes may be lost.</Text>
          <View style={{ flexDirection: "row", gap: 20 }}>
            <Pressable testID="codium-connection-cancel" accessibilityRole="button" onPress={() => setConfirmChange(false)}><Text style={{ color: colors.accent }}>Keep editing</Text></Pressable>
            <Pressable testID="codium-connection-confirm" accessibilityRole="button" onPress={apply}><Text style={{ color: colors.statusDanger }}>Change connection anyway</Text></Pressable>
          </View>
        </View> : null}
      </View> : null}
      {embedded && directory ? <EmbeddedEditor {...props} origin={connection.codiumBaseUrl} externalUrl={externalUrl} connectionKey={editorConnectionKey(connection)} onProtectedChange={setProtectedEditor} setBeforeCloseResolver={setBeforeCloseResolver} /> : null}
    </View>
  );
}
