import { useSettings, useWorkspace, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, Icon, Loading } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { codiumSettings } from "../shared/settings";
import { EMBEDDING_AVAILABLE } from "./features";
import { makeCodiumUrl, mountCodiumFrame, resolveWorkspaceFile, type FileTarget } from "./web";

interface TargetPanelProps extends PluginSurfaceProps {
  workspaceId: string;
  revision: number;
  target?: FileTarget;
  openSettings(): void;
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
  const embedded = EMBEDDING_AVAILABLE && Platform.OS === "web" && settings.values.openMode === "embedded";

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }} testID="codium-panel">
      <View style={{ padding: embedded ? 12 : 24, gap: 14 }}>
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
          <ExternalLink href={url} testID="codium-open" onError={(error) => setActionMessage(messageOf(error))}>
            <Text style={{ color: colors.accent, fontSize: 15, fontWeight: "600" }}>
              {props.target ? "Open file in VSCodium" : "Open workspace in VSCodium"}
            </Text>
          </ExternalLink>
          <Pressable accessibilityRole="button" onPress={() => {
            void copyText(url).then(() => setActionMessage("Link copied."), (error: unknown) => setActionMessage(messageOf(error)));
          }}>
            <Text style={{ color: colors.foregroundMuted }}>Copy link</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={props.openSettings}>
            <Text style={{ color: colors.foregroundMuted }}>Settings</Text>
          </Pressable>
        </View>
        {actionMessage ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted }}>{actionMessage}</Text> : null}
        {!embedded ? <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Opens the files on this host in your browser.</Text> : null}
        {target?.path.includes(":") && target.line ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>This filename contains a colon, so VSCodium opens the file without jumping to a line.</Text>
        ) : null}
      </View>
      {embedded ? <EmbeddedView url={url} revision={props.revision} theme={theme} /> : null}
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

function EmbeddedView({ url, revision, theme }: { url: string; revision: number; theme: PluginSurfaceProps["theme"] }) {
  const host = useRef<View>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    try { return mountCodiumFrame(host.current, url); }
    catch (cause) { setError(messageOf(cause)); }
  }, [url, revision]);
  return (
    <View style={{ flex: 1 }}>
      {error ? <Text style={{ padding: 12, color: theme.colors.statusDanger }}>{error}</Text> : null}
      <View ref={host} style={{ flex: 1 }} testID="codium-frame" />
    </View>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
