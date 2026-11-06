import type { PluginClientContext, PluginFilePanelContribution, PluginTab } from "@getpaseo/plugin/client";

/** Optional fork additions; the published stock SDK remains the compatibility baseline. */
export interface HostCapabilities {
  confirmedFileOpen?: 1;
  workspacePanelRetention?: 1;
}

export function readHostCapabilities(client: PluginClientContext): HostCapabilities {
  const capabilities = (client as PluginClientContext & { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object") return {};
  const values = capabilities as Record<string, unknown>;
  return {
    confirmedFileOpen: values.confirmedFileOpen === 1 ? 1 : undefined,
    workspacePanelRetention: values.workspacePanelRetention === 1 ? 1 : undefined,
  };
}

// Client TypeScript deliberately excludes DOM globals. Only read the part used here.
export interface FileOpenSignal { readonly aborted: boolean }
export interface ConfirmedFileOpenContext {
  requestId: string;
  hostId: string;
  workspaceId: string;
  workspaceDirectory: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  disposition: "main" | "preferred" | "side";
  platform: "web" | "ios" | "android";
  signal: FileOpenSignal;
}
export type ConfirmedFileOpenResult = "handled" | "render";
export type CompatibleFilePanelContribution = PluginFilePanelContribution & {
  onOpen?(request: ConfirmedFileOpenContext): ConfirmedFileOpenResult | Promise<ConfirmedFileOpenResult>;
};

export function retainedTabSetter(tab: PluginTab, enabled: boolean): ((retained: boolean) => void) | undefined {
  const setter = (tab as PluginTab & { setRetained?: (retained: boolean) => void }).setRetained;
  return enabled && typeof setter === "function" ? setter : undefined;
}
