# Paseo VSCodium

Open a separately hosted VSCodium Web IDE from Paseo. Embedded mode uses one
editor per workspace; file links navigate that editor without reloading it.
The remaining file tab provides a read-only preview. External mode opens Codium
in a browser tab.

## Setup

Requires Paseo 0.15.x and VSCodium Web with access to the same filesystem paths.
For embedded mode, run both services as the same Unix user and install the
matching [companion extension](companion/README.md).

```bash
paseo plugin add github:alexhopeoconnor/paseo-codium
```

In the plugin's **Connection** settings, enter a plain HTTPS origin such as
`https://codium.example.com`. Protect that endpoint with browser authentication.
Choose **Inside Paseo** after installing the companion; **In a browser tab** is
the default and works without it.

Build the plugin and companion from the same revision. The current companion is
`alexhopeoconnor.paseo-codium-bridge@0.1.1`, protocol `1`. Install its verified VSIX
with Codium's server launcher and the same data and extension directories as the
running service. Save edits and close editor sessions before updating either
component.

## Use

- Open **Command Center → Open workspace in VSCodium**, or select **VSCodium**
  in a file's **Open with** chooser. Embedded file opens select the workspace
  editor automatically; **Open in VSCodium tab** retries a failed request.
- The file tab previews saved content. Markdown offers **Preview / Source**;
  other text stays source. HTML, SVG and MDX components are not executed.
- Codium uses your browser's login session. If login is required, choose **Sign
  in in browser**, then return and **Reconnect**. The plugin stores no browser
  credentials.
- Saving connection settings leaves open editors unchanged until **Apply changed
  connection settings**. Pending files wait for the intended connection and expire
  after five minutes. A full browser refresh clears pending requests.
- Dirty, disconnected or focused editors may require confirmation before closing,
  reconnecting or changing connection. Save files in Codium before confirming.

## Limits

- Paseo can mount a file viewer before its chooser is confirmed, so automatic
  opening can occur before **Use**. Its public SDK exposes no confirmed-choice
  signal.
- Paseo retains the intermediate file tab and may route some file-at-line links
  to its built-in viewer. Native clients use external opening.
- Paseo may unmount clean background editors after several tab switches. Returning
  restores the last file; Codium manages its other editor and terminal recovery.
  Suspended sessions may need **Reconnect** after 30 minutes.
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

Install development dependencies in Docker, then test and package without network
access. Keep generated artifacts outside the checkout:

```bash
codium_build_image=node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99
codium_output=$(mktemp -d)

docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/work" --workdir /work --env HOME=/tmp \
  "$codium_build_image" npm ci --ignore-scripts --no-audit --no-fund

docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/work" \
  --mount "type=bind,src=$codium_output,dst=/output" \
  --workdir /work --env HOME=/tmp "$codium_build_image" \
  sh -c 'npm run typecheck && npm test && npm run build:companion -- --out-dir /output'
```

The output directory contains `paseo-codium-bridge.vsix` and `companion.json`.
Do not commit generated artifacts or `node_modules`.

API references: [Paseo plugins](https://paseo.sh/docs/plugins/reference) and
[VS Code extensions](https://code.visualstudio.com/api/references/vscode-api).
