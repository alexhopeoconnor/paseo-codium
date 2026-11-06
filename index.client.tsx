import type { PluginClientContext, PluginFilePanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { CodiumFilePanel } from "./client/file-panel";
import { CodiumSettingsScreen } from "./client/settings";
import { CodiumWorkspacePanel } from "./client/workspace-panel";
import { clearEditorQueues, editorQueue } from "./client/editor-session";
import { newRequestId } from "./client/web";
import { readHostCapabilities, type CompatibleFilePanelContribution } from "./client/host-capabilities";
import { createConfirmedFileOpener } from "./client/file-open";

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings("connection");
  const capabilities = readHostCapabilities(client);
  const directOpen = capabilities.confirmedFileOpen === 1;
  const cleanups = [
    client.addSettingsScreen({ id: "connection", title: "Connection", icon: "Settings", Component: CodiumSettingsScreen }),
    client.addWorkspacePanel({
      id: "codium", title: "VSCodium", icon: "Code",
      Component: (props: PluginWorkspacePanelProps) => <CodiumWorkspacePanel {...props} retainEditor={capabilities.workspacePanelRetention === 1} freshCloseProtection={capabilities.workspacePanelCloseProtection === 1} openSettings={openSettings} />,
    }),
    client.addCommandCenterItem({
      id: "open-codium", title: "Open workspace in VSCodium", icon: "Code",
      keywords: ["editor", "code", "ide"], context: "workspace",
      onSelect({ openPanel }) { openPanel("codium"); },
    }),
    client.addFilePanel({
      ...(directOpen ? { onOpen: createConfirmedFileOpener(client) } : {}),
      id: "codium-file", title: "VSCodium", icon: "Code",
      files: {
        extensions: ["md", "mdx", "txt", "py", "pyi", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "sh", "bash", "html", "css", "scss", "svg", "xml", "sql", "go", "rs", "c", "cpp", "cc", "h", "hpp", "cs", "java", "kt", "rb", "php", "vue", "svelte", "tex", "typ"],
        filenames: ["Dockerfile", "Containerfile", "Makefile", "Justfile", ".gitignore", ".gitattributes", ".editorconfig", "LICENSE"],
      },
      Component: (props: PluginFilePanelProps) => <CodiumFilePanel {...props} autoForward={!directOpen} openSettings={openSettings} openEditor={(target, connectionKey) => {
        const queue = editorQueue(props.host.id, props.workspaceId), requestId = newRequestId();
        queue.route({ requestId, target, connectionKey }, () => client.openPanel("codium", { workspaceId: props.workspaceId }));
      }} />,
    } satisfies CompatibleFilePanelContribution),
  ];
  return () => { for (const cleanup of cleanups) cleanup(); clearEditorQueues(); };
}
