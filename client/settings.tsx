import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { codiumPresentationSettings, codiumSettings, connectionSchema } from "../shared/settings";

export function CodiumSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(codiumSettings);
  const presentation = useSettings(codiumPresentationSettings);
  const [draft, setDraft] = useState<{ value: string; revision: string } | null>(null);
  if (settings.status !== "ready" || presentation.status !== "ready") {
    return (
      <SettingsSection title="Connection">
        <SettingsCard>
          <SettingsRow label="Settings" hint={settings.status === "loading" || presentation.status === "loading" ? "Loading…" : undefined}
            error={settings.status === "invalid" ? settings.error : "error" in settings ? settings.error : null} />
          {settings.status === "invalid" ? <SettingsAction label="Reset invalid connection settings" actionLabel="Reset" onPress={() => { void settings.reset(); }} disabled={settings.saving} /> : null}
          <SettingsRow label="Presentation" hint={presentation.status === "loading" ? "Loading…" : undefined}
            error={presentation.status === "invalid" ? presentation.error : "error" in presentation ? presentation.error : null} />
          {presentation.status === "invalid" ? <SettingsAction label="Reset invalid presentation settings" actionLabel="Reset" onPress={() => { void presentation.reset(); }} disabled={presentation.saving} /> : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  const input = (draft?.value ?? settings.values.codiumBaseUrl).trim();
  const conflict = draft !== null && draft.revision !== settings.revision;
  const candidate = connectionSchema.safeParse({ ...settings.values, codiumBaseUrl: input });
  const validationError = candidate.success ? null : candidate.error.issues[0]?.message ?? "Invalid address.";
  const save = async () => {
    if (!candidate.success || draft === null || conflict) return;
    if (await settings.save(candidate.data, draft.revision)) setDraft(null);
  };

  return (
    <SettingsSection title="Connection">
      <SettingsCard>
        <SettingsInput
          key={draft?.revision ?? settings.revision}
          label="VSCodium Web address"
          hint="The HTTPS address of your VSCodium Web instance. Leave empty to disconnect."
          initialValue={draft?.value ?? settings.values.codiumBaseUrl}
          placeholder="https://codium.example.com"
          onChangeText={(value) => setDraft((previous) => ({ value, revision: previous?.revision ?? settings.revision }))}
          disabled={settings.saving}
          error={validationError}
        />
        <SettingsAction label="Save connection" actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={draft === null || !candidate.success || conflict || settings.saving}
          onPress={() => void save()} error={settings.saveError} />
        {conflict ? <SettingsAction label="Settings changed on another client" actionLabel="Reload saved settings"
          hint="Reload to discard this draft and edit the latest saved connection."
          onPress={() => { setDraft(null); void settings.reload(); }} /> : null}
        <SettingsSelect
          label="Open VSCodium" value={settings.values.openMode}
          options={[{ label: "In a browser tab", value: "external" }, { label: "Inside Paseo", value: "embedded" }]}
          disabled={settings.saving || draft !== null}
          onValueChange={(openMode) => { void settings.save({ ...settings.values, openMode }, settings.revision); }}
          hint="Embedded mode requires the matching Codium companion. Open panels apply changed settings only when you choose to switch."
        />
        <SettingsSelect
          label="Codium primary sidebar"
          value={presentation.values.closePrimarySidebar ? "close" : "keep"}
          options={[{ label: "Close once on a new editor window", value: "close" }, { label: "Leave it open", value: "keep" }]}
          disabled={presentation.saving}
          onValueChange={(value) => { void presentation.save({ closePrimarySidebar: value === "close" }, presentation.revision); }}
          error={presentation.saveError}
          hint="Presentation only. Applies to newly paired editor windows; it never reloads the editor, and you can reopen the sidebar at any time."
        />
        {presentation.saveError ? <SettingsAction label="Retry saving Codium primary sidebar"
          actionLabel={presentation.saving ? "Saving…" : "Retry"} disabled={presentation.saving}
          onPress={() => { void presentation.save({ closePrimarySidebar: presentation.values.closePrimarySidebar }, presentation.revision); }} /> : null}
      </SettingsCard>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 12 }}>
        Choose an instance that can access the same project paths as this Paseo host. Its existing login protects access.
      </Text>
    </SettingsSection>
  );
}
