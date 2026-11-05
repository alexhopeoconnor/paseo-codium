import type { PluginClientContext, PluginFilePanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { CodiumFilePanel } from "./client/file-panel";
import { CodiumSettingsScreen } from "./client/settings";
import { CodiumWorkspacePanel } from "./client/workspace-panel";

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings("connection");
  const cleanups = [
    client.addSettingsScreen({ id: "connection", title: "Connection", icon: "Settings", Component: CodiumSettingsScreen }),
    client.addWorkspacePanel({
      id: "codium", title: "VSCodium", icon: "Code",
      Component: (props: PluginWorkspacePanelProps) => <CodiumWorkspacePanel {...props} openSettings={openSettings} />,
    }),
    client.addCommandCenterItem({
      id: "open-codium", title: "Open workspace in VSCodium", icon: "Code",
      keywords: ["editor", "code", "ide"], context: "workspace",
      onSelect({ openPanel }) { openPanel("codium"); },
    }),
    client.addFilePanel({
      id: "codium-file", title: "VSCodium", icon: "Code",
      files: {
        extensions: ["md", "mdx", "txt", "py", "pyi", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "sh", "bash", "html", "css", "scss", "svg", "xml", "sql", "go", "rs", "c", "cpp", "cc", "h", "hpp", "cs", "java", "kt", "rb", "php", "vue", "svelte", "tex", "typ"],
        filenames: ["Dockerfile", "Containerfile", "Makefile", "Justfile", ".gitignore", ".gitattributes", ".editorconfig", "LICENSE"],
      },
      Component: (props: PluginFilePanelProps) => <CodiumFilePanel {...props} openSettings={openSettings} />,
    }),
  ];
  return () => { for (const cleanup of cleanups) cleanup(); };
}
