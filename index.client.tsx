import type { PluginClientContext, PluginFilePanelContribution, PluginFilePanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { CodiumFilePanel } from "./client/file-panel";
import { CodiumSettingsScreen } from "./client/settings";
import { CodiumWorkspacePanel } from "./client/workspace-panel";
import { clearEditorQueues, editorQueue } from "./client/editor-session";
import { newRequestId } from "./client/web";
import { openPanelOptions, readHostCapabilities, revealPaseoFile, type CompatibleFilePanelContribution } from "./client/host-capabilities";
import { createConfirmedFileOpener } from "./client/file-open";

const extensions = ["md", "mdx", "txt", "py", "pyi", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "sh", "bash", "html", "css", "scss", "svg", "xml", "sql", "go", "rs", "c", "cpp", "cc", "h", "hpp", "cs", "java", "kt", "rb", "php", "vue", "svelte", "tex", "typ"];
const filenames = ["Dockerfile", "Containerfile", "Makefile", "Justfile", ".gitignore", ".gitattributes", ".editorconfig", "LICENSE"];

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings("connection");
  const capabilities = readHostCapabilities(client);
  const directOpen = capabilities.confirmedFileOpen === 1;
  // A capable host classifies bounded text files itself. Older hosts keep the
  // reviewed extension/filename selectors exactly as before.
  const files = (capabilities.textFilePanels === 1 ? { kind: "text" } : { extensions, filenames }) as PluginFilePanelContribution["files"];
  const cleanups = [
    client.addSettingsScreen({ id: "connection", title: "Connection", icon: "Settings", Component: CodiumSettingsScreen }),
    client.addWorkspacePanel({
      id: "codium", title: "VSCodium", icon: "Code",
      Component: (props: PluginWorkspacePanelProps) => <CodiumWorkspacePanel {...props} capabilities={capabilities}
        retainEditor={capabilities.workspacePanelRetention === 1} freshCloseProtection={capabilities.workspacePanelCloseProtection === 1}
        revealFile={capabilities.fileReveal === 1 ? (path, intent, options) => {
          // Fresh panel-scoped reveal: never reuse the settled host route id.
          return revealPaseoFile(client, capabilities, { workspaceId: props.workspaceId, path, source: "editor", intent }, options);
        } : undefined}
        openSettings={openSettings} />,
    }),
    client.addCommandCenterItem({
      id: "open-codium", title: "Open workspace in VSCodium", icon: "Code",
      keywords: ["editor", "code", "ide"], context: "workspace",
      onSelect({ openPanel }) { openPanel("codium"); },
    }),
    client.addFilePanel({
      ...(directOpen ? { onOpen: createConfirmedFileOpener(client) } : {}),
      id: "codium-file", title: "VSCodium", icon: "Code",
      files,
      Component: (props: PluginFilePanelProps) => <CodiumFilePanel {...props} capabilities={capabilities} autoForward={!directOpen} openSettings={openSettings}
        revealInFiles={capabilities.fileReveal === 1 ? (options) => revealPaseoFile(client, capabilities, {
          workspaceId: props.workspaceId, path: props.file.path, source: "plugin", intent: "explicit",
        }, options) : undefined}
        openEditor={(target, connectionKey) => {
        const queue = editorQueue(props.host.id, props.workspaceId), requestId = newRequestId();
        queue.route({ requestId, target, connectionKey }, () => client.openPanel("codium", openPanelOptions(capabilities, props.workspaceId)));
      }} />,
    } satisfies CompatibleFilePanelContribution),
  ];
  return () => { for (const cleanup of cleanups) cleanup(); clearEditorQueues(); };
}
