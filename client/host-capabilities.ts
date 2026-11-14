import type { PluginClientContext, PluginClientOpenPanelOptions, PluginFilePanelContribution, PluginTab } from "@getpaseo/plugin/client";

/** Optional fork additions; the published stock SDK remains the compatibility baseline. */
export interface HostCapabilities {
  confirmedFileOpen?: 1;
  workspacePanelRetention?: 1;
  workspacePanelCloseProtection?: 1;
  /** Host routes requestId back to the original live panel without remounting it. */
  requestBoundPanelPlacement?: 1;
  /** Host exposes actual tab visibility, not focus. */
  workspacePanelVisibility?: 1;
  /** Host supports scoped Paseo-tree reveal, Paseo tree selections only. */
  fileReveal?: 1;
  /** Host classifies bounded text files for a kind:text contribution. */
  textFilePanels?: 1;
}

export function readHostCapabilities(client: PluginClientContext): HostCapabilities {
  const capabilities = (client as PluginClientContext & { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object") return {};
  const values = capabilities as Record<string, unknown>;
  return {
    confirmedFileOpen: values.confirmedFileOpen === 1 ? 1 : undefined,
    workspacePanelRetention: values.workspacePanelRetention === 1 ? 1 : undefined,
    workspacePanelCloseProtection: values.workspacePanelCloseProtection === 1 ? 1 : undefined,
    requestBoundPanelPlacement: values.requestBoundPanelPlacement === 1 ? 1 : undefined,
    workspacePanelVisibility: values.workspacePanelVisibility === 1 ? 1 : undefined,
    fileReveal: values.fileReveal === 1 ? 1 : undefined,
    textFilePanels: values.textFilePanels === 1 ? 1 : undefined,
  };
}

/**
 * Only a host that advertises request-bound placement receives the original
 * confirmed request id. Stock hosts keep the previous openPanel options exactly.
 */
export function openPanelOptions(capabilities: HostCapabilities, workspaceId: string, requestId?: string): PluginClientOpenPanelOptions {
  if (capabilities.requestBoundPanelPlacement === 1 && requestId) {
    return { workspaceId, requestId } as PluginClientOpenPanelOptions & { requestId: string };
  }
  return { workspaceId };
}

/** Actual layout visibility from a capable host; focus is deliberately not used. */
export function tabIsVisible(tab: PluginTab, capabilities: HostCapabilities): boolean | undefined {
  if (capabilities.workspacePanelVisibility !== 1) return undefined;
  const visible = (tab as PluginTab & { readonly visible?: unknown }).visible;
  return typeof visible === "boolean" ? visible : undefined;
}

export type RevealSource = "explorer" | "search" | "chat" | "editor" | "plugin";
export interface RevealFileRequest {
  workspaceId: string;
  path: string;
  source: RevealSource;
  intent: "auto" | "explicit";
  requestId?: string;
}
export interface RevealFileOptions { signal?: FileOpenSignal; ttlMs?: number }
export interface RevealLifetime { readonly signal: FileOpenSignal; abort(): void }
declare const AbortController: { new (): RevealLifetime } | undefined;
/** Fresh lifetime for a mounted panel/editor generation, aborted on replacement. */
export function createRevealLifetime(): RevealLifetime {
  if (typeof AbortController === "undefined") return { signal: { aborted: false }, abort() {} };
  return new AbortController();
}
export type RevealFileResult = "revealed" | "cancelled" | "unavailable" | "unsupported";
export type CompatibleRevealFileResult =
  | { status: "revealed" }
  | { status: "cancelled" }
  | { status: "unavailable"; reason?: string };
type CompatibleRevealFile = (input: RevealFileRequest, options?: RevealFileOptions) =>
  Promise<CompatibleRevealFileResult> | CompatibleRevealFileResult;
export type RevealFileClient = PluginClientContext & { revealFile?: CompatibleRevealFile };

/**
 * Paseo-tree reveal only. Auto reveal updates Files only if it is already visible
 * and never changes focus; explicit reveal opens Files. No Codium editor/file tab
 * is opened by this call.
 */
export async function revealPaseoFile(
  client: PluginClientContext, capabilities: HostCapabilities, input: RevealFileRequest, options?: RevealFileOptions,
): Promise<RevealFileResult> {
  if (capabilities.fileReveal !== 1) return "unsupported";
  const reveal = (client as RevealFileClient).revealFile;
  if (typeof reveal !== "function") return "unsupported";
  try {
    const result = await reveal.call(client, input, options);
    return result.status === "revealed" || result.status === "cancelled" ? result.status : "unavailable";
  } catch {
    return "unavailable";
  }
}

// Client TypeScript deliberately excludes DOM globals. Only read the part used here.
export interface FileOpenSignal {
  readonly aborted: boolean;
  /** Host AbortSignal may support subscriptions; older signals may not. */
  addEventListener?(type: "abort", listener: () => void): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}
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

export type CloseProtectionResolver = () => boolean | Promise<boolean>;
export function closeProtectionSetter(tab: PluginTab, enabled: boolean): ((resolver: CloseProtectionResolver | null) => void) | undefined {
  const setter = (tab as PluginTab & { setCloseProtectionResolver?: (resolver: CloseProtectionResolver | null) => void }).setCloseProtectionResolver;
  return enabled && typeof setter === "function" ? setter : undefined;
}
