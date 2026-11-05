Use a separately hosted VSCodium Web IDE from Paseo, with the exact checkout or Git worktree directory. External mode opens the standalone IDE. Embedded mode provides one workspace editor panel and uses the matching Codium companion to open files without reloading the workbench.

The remaining file tab shows a read-only preview: Markdown has Preview and Source views; other supported text stays selectable source. Saved changes refresh that preview. The workspace editor reports connection and unsaved state, with guarded reload controls and normal-browser sign-in when needed.

Run both applications as the same Unix user with the same filesystem paths. Configure the Codium HTTPS origin and protect it with browser authentication. The local companion bridge uses an owner-restricted Unix socket; it introduces no public listener and does not execute repository configuration or shell commands. Connection settings are shared across authorized clients of the Paseo host.

Paseo 0.15.x still controls file associations and tab lifetime. It can mount a default viewer before its chooser is confirmed, so automatic Codium forwarding can occur before Use; this known host/integration issue remains unresolved. Built-in file-at-line routing and clean-panel eviction also limit seamless integration. See README.md for installation, preview bounds, lifecycle behavior and verification requirements.
