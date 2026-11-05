import { useFileText, type PluginFile, type PluginHostProps } from "@getpaseo/plugin/client";
import { Loading, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { boundedPreviewFile, richPreviewAllowed } from "./file-preview-text";

export function FilePreview({ file, theme }: { file: PluginFile; theme: PluginHostProps["theme"] }) {
  const [retry, setRetry] = useState(0);
  const [source, setSource] = useState(false);
  const bounded = useMemo(() => boundedPreviewFile(file), [file, retry]);
  const contents = useFileText(bounded);
  const markdown = file.extension === "md" || file.extension === "mdx";
  const richLimited = markdown && contents.status === "ready" && !richPreviewAllowed(contents.text);
  const showSource = source || richLimited;
  const { colors } = theme;
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }} testID="codium-file-preview">
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 14, paddingVertical: 8 }}>
      {markdown ? <>
        <Pressable testID="codium-preview-mode" accessibilityRole="button" disabled={richLimited} accessibilityState={{ selected: !showSource, disabled: richLimited }} onPress={() => setSource(false)}>
          <Text style={{ color: showSource ? colors.foregroundMuted : colors.accent }}>Preview</Text>
        </Pressable>
        <Pressable testID="codium-source-mode" accessibilityRole="button" accessibilityState={{ selected: showSource }} onPress={() => setSource(true)}>
          <Text style={{ color: showSource ? colors.accent : colors.foregroundMuted }}>Source</Text>
        </Pressable>
      </> : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Read-only</Text>
    </View>
    {richLimited ? <Text testID="codium-preview-limit" style={{ paddingHorizontal: 14, paddingBottom: 8, color: colors.foregroundMuted, fontSize: 12 }}>
      Preview is limited to four Mermaid diagrams. Showing source for this file.
    </Text> : null}
    {contents.status === "loading" ? <Loading /> : contents.status === "error" ?
      <View style={{ padding: 18, gap: 12 }}>
        <Text testID="codium-preview-error" accessibilityLiveRegion="polite" style={{ color: colors.statusDanger }}>{contents.error.message}</Text>
        <Pressable testID="codium-preview-retry" accessibilityRole="button" onPress={() => setRetry((value) => value + 1)}>
          <Text style={{ color: colors.accent }}>Retry preview</Text>
        </Pressable>
      </View> : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {contents.text.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>This file is empty.</Text> :
          markdown && !showSource ? <Markdown>{contents.text}</Markdown> :
            <Text selectable testID="codium-file-source" style={{ color: colors.foreground, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, lineHeight: 20 }}>
              {contents.text}
            </Text>}
      </ScrollView>}
  </View>;
}
