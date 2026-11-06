import { openExternalUrl, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = PluginWorkspacePanelProps["theme"];
export interface EditorConnectionIndicator {
  kind: "connecting" | "connected" | "disconnected" | "external";
  message: string;
  dirty?: boolean;
}

function IconAction(props: { theme: Theme; icon: string; label: string; color?: string; testID: string; disabled?: boolean; onPress?(): void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const { colors } = props.theme;
  return <View style={{ position: "relative" }}>
    <Pressable testID={props.testID} accessibilityRole={props.onPress ? "button" : "image"}
      accessibilityLabel={props.label} accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled} focusable onPress={props.onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 6,
        backgroundColor: hovered || focused ? colors.surface1 : colors.surface0, opacity: props.disabled ? 0.45 : 1 }}>
      <Icon name={props.icon} size={17} color={props.color ?? colors.foregroundMuted} />
    </Pressable>
    {hovered || focused ? <View pointerEvents="none" style={{ position: "absolute", top: 36, right: 0, zIndex: 20,
      minWidth: 100, width: props.label.length > 32 ? 240 : undefined, maxWidth: 280, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 5,
      backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }}>
      <Text accessible={false} style={{ color: colors.foreground, fontSize: 12 }}>{props.label}</Text>
    </View> : null}
  </View>;
}

export function EditorToolbar(props: {
  theme: Theme; externalUrl: string; connection: EditorConnectionIndicator;
  reconnecting?: boolean; onReconnect?(): void; openSettings(): void; onError(message: string): void;
}) {
  const { colors } = props.theme;
  const disconnected = props.connection.kind === "disconnected";
  const message = disconnected ? `${props.connection.message} Click to reconnect. If sign-in needs renewing, use Open directly first.` : props.connection.message;
  return <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.surface0, zIndex: 2 }}>
    {props.connection.kind !== "external" ? <IconAction theme={props.theme} testID="codium-connection-status"
      icon={props.connection.kind === "connected" ? "Wifi" : props.connection.kind === "connecting" ? "LoaderCircle" : "WifiOff"}
      color={props.connection.kind === "connected" ? props.connection.dirty ? colors.statusWarning : colors.statusSuccess : colors.foregroundMuted}
      label={message} disabled={props.reconnecting} onPress={disconnected ? props.onReconnect : undefined} /> : null}
    <IconAction theme={props.theme} testID="codium-open-directly" icon="ExternalLink" label="Open directly"
      disabled={!props.externalUrl} onPress={() => { void openExternalUrl(props.externalUrl).catch(() => props.onError("Codium could not be opened directly. Check the connection address in Settings.")); }} />
    <IconAction theme={props.theme} testID="codium-settings" icon="Settings" label="Settings" onPress={props.openSettings} />
  </View>;
}
