# Paseo VSCodium

> Developed and supported for the [workstation fork](https://github.com/alexhopeoconnor/paseo/tree/workstation).
> Build and install locally from reviewed source. Binary release assets are not published.

Open a separately hosted VSCodium Web IDE from Paseo. Embedded mode uses one
editor per workspace; file links navigate that editor without reloading it.
Capable Paseo hosts dispatch confirmed file opens directly to that editor and
retain it while backgrounded. Stock hosts keep a read-only file preview alongside
the editor. External mode opens Codium in a browser tab.

## Setup

Requires a reviewed workstation-fork release and VSCodium Web with access to the
same filesystem paths. The manifest's `^0.15.0` SDK range is not a claim of tested
stock-host compatibility; the fallback behavior below describes graceful degradation.
For embedded mode, run both services as the same Unix user and install the
matching [companion extension](companion/README.md).

```bash
paseo plugin add github:alexhopeoconnor/paseo-codium --ref FULL_REVIEWED_COMMIT
```

In the plugin's **Connection** settings, enter a plain HTTPS origin such as
`https://codium.example.com`. Protect that endpoint with browser authentication.
Choose **Inside Paseo** after installing the companion; **In a browser tab** is
the default and works without it.

Select an exact commit using the fork's
[installation guide](https://github.com/alexhopeoconnor/paseo/tree/workstation#optional-workstation-plugins).
No private infrastructure repository or artifact registry is required.

Build the plugin and companion from that same revision. The current companion is
`alexhopeoconnor.paseo-codium-bridge@0.1.2`, protocol `1`. Install its verified VSIX
with Codium's server launcher and the same data and extension directories as the
running service. Save edits and close editor sessions before updating either
component.

## Use

- Open **Command Center → Open workspace in VSCodium**, or select **VSCodium**
  in a file's **Open with** chooser. Embedded file opens select the workspace
  editor automatically. If a direct open fails, retry from the explorer, search
  or original link. On stock hosts or a rendered fallback, use **Open in VSCodium
  tab** to retry from the file tab.
- Stock and fallback file tabs preview saved content. Markdown offers **Preview /
  Source**; other text stays source. HTML, SVG and MDX components are not executed.
- The compact toolbar offers **Open directly**, **Settings**, and connection
  status. Hover or focus an icon for its hint; click a disconnected status icon
  to reconnect. Open directly keeps the same workspace folder and can renew your
  browser login when needed. The plugin stores no browser credentials.
- Saving connection settings leaves open editors unchanged until **Apply changed
  connection settings**. Pending files wait for the intended connection and expire
  after five minutes. A full browser refresh clears pending requests.
- Dirty or unknown editors require confirmation before closing, reconnecting or
  changing connection. Hosts with `workspacePanelCloseProtection: 1` query fresh
  paired-window state at close time, so focusing a clean editor does not mark it
  modified. Stock hosts retain conservative focus protection. Save files in Codium
  before confirming a protected close.
- Hosts advertising `confirmedFileOpen: 1` send files only after confirming the
  viewer choice, without an intermediate file tab. One request ID follows the
  navigation through the existing companion queue. Cancelling its host/workspace
  lifetime drops pending navigation. Hosts advertising `workspacePanelRetention: 1`
  retain mounted embedded editors independently from unsaved-change protection.
  Close the editor explicitly to release it; retention does not survive browser
  refresh or process termination.

## Limits

- Stock Paseo can mount a file viewer before its chooser is confirmed, so automatic
  opening can occur before **Use**. Its public SDK exposes no confirmed-choice
  signal.
- Stock Paseo retains the intermediate file tab and may route some file-at-line links
  to its built-in viewer. Native clients use external opening.
- Hosts without panel retention may unmount clean background editors after several tab switches. Returning
  restores the last file; Codium manages its other editor and terminal recovery.
  Suspended sessions may need the connection icon's reconnect action after 30 minutes.
- Previews are limited to 512 KiB and never save files. The SDK cannot bound a read
  when size metadata is unavailable or stale. Markdown can load remote images;
  relative assets lack the built-in viewer's workspace-aware handling. Files with
  more than four Mermaid blocks remain in Source mode.
- External URLs cannot jump to a line in filenames containing colons. Connected
  companion navigation supports them.
- Workspace folders are navigation context, not a filesystem sandbox. Both
  applications retain their host account's access. Embedding requires the Codium
  endpoint to allow Paseo in its framing policy.

## Development

Paseo compiles the plugin source. The companion uses Codium's extension API and
Node builtins. Neither output needs production npm dependencies.

Copy source into an isolated build directory, install development dependencies in
Docker, then test and package without network access. The source checkout remains
free of dependencies, build output and dependency-installed hooks:

```bash
codium_build_image=node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99
codium_work=$(mktemp -d)
codium_output=$(mktemp -d)
# Run in a checkout at the exact revision selected for installation.
git archive HEAD | tar -xf - -C "$codium_work"

docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$codium_work,dst=/work" --workdir /work --env HOME=/tmp \
  "$codium_build_image" npm ci --ignore-scripts --no-audit --no-fund

docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$codium_work,dst=/work" \
  --mount "type=bind,src=$codium_output,dst=/output" \
  --workdir /work --env HOME=/tmp "$codium_build_image" \
  sh -c 'npm run typecheck && npm test && npm run build:companion -- --out-dir /output'

rm -rf -- "$codium_work"
```

The output directory contains `paseo-codium-bridge.vsix` and `companion.json`.
Do not commit generated artifacts or `node_modules`.

API references: [Paseo plugins](https://paseo.sh/docs/plugins/reference) and
[VS Code extensions](https://code.visualstudio.com/api/references/vscode-api).
