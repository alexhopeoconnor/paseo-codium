# Paseo VSCodium

Use a separately hosted VSCodium Web IDE from Paseo. External mode opens the
workspace or file in your browser. Embedded mode uses one workspace editor panel
and the matching Codium companion for file navigation, readiness and unsaved-state
reporting without reloading the IDE for each file.

## Installation and connection

Run VSCodium Web independently, with the same absolute filesystem paths as the
Paseo daemon. Protect its public browser endpoint with authentication. Install this
plugin on Paseo 0.15.0 or later:

```bash
paseo plugin add github:alexhopeoconnor/paseo-codium
```

Set the plugin's **Connection** address to a plain HTTPS origin such as
`https://codium.example.com`. An empty address remains safely unconfigured.
External mode is the default and requires no companion. Choose **Inside Paseo**
only after installing the matching companion and verifying your browser setup.

The companion ID is `alexhopeoconnor.paseo-codium-bridge`, version `0.1.0`, using
protocol `1`. It is packaged as `paseo-codium-bridge.vsix` from the same signed
source revision as the plugin. Install the verified VSIX with Codium's server
launcher, using the same server/user/extension directories as the running service.
The workstation deployment tooling pins, checks and installs both outputs.

From **Command Center → Open workspace in VSCodium**, the workspace panel opens
the actual checkout or linked-worktree directory. Supported files offer
**VSCodium** under **Open with**. In embedded web mode opening a supported file
automatically focuses the shared VSCodium workspace tab and sends it the file.
The remaining file tab shows a read-only preview with a compact toolbar:
**Open in VSCodium tab** for retrying, plus **Open in browser**, **Copy link** and
**Settings**. Markdown files offer **Preview / Source**; other text files display
selectable monospace source. HTML and SVG stay source text, and MDX is rendered
as Markdown without compiling or executing its components.

The preview uses Paseo's supported file-read hooks and Markdown component; it is
not the private built-in editor. It follows saved disk changes, reports deletion
or read failures, and remains usable with an unconfigured Codium address. Relative
Markdown images and links do not have the built-in file viewer's workspace-aware
asset handling. Preview is limited to 512 KiB: files reported as oversized or with
invalid size metadata are rejected before reading, and returned content is checked
again before rendering. Paseo can report zero before metadata is available, and
its SDK has no ranged read. Missing metadata or a file growing during a read may
therefore allow more than the limit to transfer before it is rejected. Rendered
Markdown follows Paseo's image loading behavior, including remote images; those
image resources are outside the
text-size limit. Reading a preview never saves the file.
Files with more than four Mermaid fenced blocks stay in Source mode because
Paseo creates a separate diagram runtime for each block. The Preview toggle cannot
override this limit; header counting is deliberately conservative for nested examples.

## Authentication and editor sessions

Your browser loads Codium directly in the iframe. Existing browser cookies and
your endpoint's normal authentication apply. The plugin does not log into Codium
or store Authentik credentials. If interactive login cannot display in the frame,
choose **Sign in in browser**, return, then **Reconnect**. The sign-in action uses
the clean origin and never transfers the temporary editor pairing URL to another
tab. A loading timeout means readiness is unconfirmed; it is not proof of an
authentication failure. Only the companion handshake establishes readiness.

The TypeScript backend brokers editor commands over a user-owned Unix socket at
`$XDG_RUNTIME_DIR/paseo-codium/bridge.sock` (or `/run/user/UID` on Linux when the
variable is absent). Directory and socket modes are `0700` and `0600`. No public
port or separate service is introduced. The browser uses Paseo's authenticated
RPC connection and a private panel credential; the companion runs as the same
host user. This is not a sandbox against other processes belonging to that user.

An initial, read-only `paseo-codium-session` virtual document binds the exact
Codium window receiving the iframe URL. Pairing capabilities expire after two
minutes if unclaimed. They are single-window capabilities, omitted from this
plugin and companion's logs and persisted settings. The bootstrap URI can still
appear in browser/workbench history or upstream diagnostics; it is not an
Authentik credential and cannot bind another window after it is claimed.
The same live extension instance can reconnect its local
socket; another window cannot reuse its binding. Restarting the plugin broker
requires reconnecting the panel after preserving any edits.

Sessions expire after 30 minutes without panel RPC activity, so a suspended
browser may require explicit reconnection. A failed file request displays a retry
error rather than replaying later; pending requests do not survive a full browser
refresh.
Each extension-host activation generates its own window identity; Codium's
telemetry session ID is not used because telemetry-off builds can share a placeholder.

The companion opens files through editor APIs and observes text documents,
notebooks and custom-editor tab dirtiness. It supports Restricted Mode without
executing repository configuration, running shell commands or trusting folders.
Its temporary bootstrap document creates no project files and closes only its
own matching tab. Changing the window's workspace folders invalidates its binding.

## Unsaved changes and lifecycle limits

The companion reports dirty state to Paseo's native modified-tab API. Unknown or
disconnected editor state remains protected; it is never treated as clean merely
because a connection timed out. Because removing a cross-origin iframe can bypass
the editor's normal page-unload confirmation, the Paseo tab is also conservatively
protected while the iframe owns focus. After focus returns to Paseo, a fresh
clean-state snapshot clears that protection. Each state RPC performs a bounded,
request-correlated round trip to the companion; cached clean state cannot satisfy
that freshness check. This can produce a close/reload
confirmation for a focused editor that has no unsaved files.

Reconnect and connection-setting changes require an explicit discard choice
when state is dirty or unknown. Saving files remains Codium's responsibility;
the plugin's modified indicator does not save them. Abrupt browser/process
termination still relies on Codium's own recovery mechanisms.

Known Paseo 0.15.0 boundaries:

- Clean background panels may be unmounted after several tab switches. The SDK
  has no permanent keep-alive API. The panel creates a new binding when remounted
  and restores its last successfully opened target; Codium owns other workbench
  and terminal restoration. Do not assume every background terminal remains
  continuously attached. Dirty/unknown panels use the native retention flag.
- The file launcher tab remains because the SDK has no close-tab API. Automatic
  forwarding consumes each positive host file-open revision once, including an
  intentional second click on the same file. Hidden launchers wait until visible;
  remounts and plugin reloads do not replay a recorded attempt. Browser-restored
  revision-zero tabs stay quiet until another file-open action. When upgrading
  from a release without these markers, an unhandled visible file tab can forward
  once. Merely selecting an already handled launcher offers its retry button.
- File opens in external or unconfigured mode are consumed without redirecting;
  changing to embedded mode later does not reopen those old requests. Automatic
  forwarding never launches an external browser window. Failed attempts require
  the retry action or another file click.
- Existing file-at-line links can force Paseo's built-in panel despite saved
  associations. This plugin cannot override every chat link.
- Native clients use external opening. Embedded mode is a web-client capability.
- File selectors use declared extensions and exact filenames; no wildcard
  selector is available in this SDK.
- The workspace folder is navigation context, not a filesystem sandbox. Explicit
  absolute file targets may be outside it. Both applications run with their host
  account's permissions.
- Connected editor navigation preserves colons and reserved filename characters.
  External URLs retain the upstream colon limitation: a colon-containing path
  opens the exact file without a cursor jump.

Browser authentication, clipboard, keyboard, focus, dirty-close behaviour and
clean-panel restoration must be verified against the deployed Paseo/Codium builds.
Automated protocol tests do not establish those browser results.

## Development and packaging

There are no production package dependencies or manifest preparation commands.
Paseo supplies the SDK, React, React Native and Zod and compiles the plugin source.
The companion bundles its own code and uses Codium's `vscode` API and Node builtins.
Host npm is not required for plugin or VSIX installation.

Use the pinned Docker image from this checkout:

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/work" --workdir /work --env HOME=/tmp \
  node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 \
  npm ci --ignore-scripts --no-audit --no-fund

docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/work" --workdir /work --env HOME=/tmp \
  node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 \
  npm run typecheck

docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/work" --workdir /work --env HOME=/tmp \
  node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 \
  npm test
```

The root lockfile also pins TypeScript, esbuild and VS Code API development types.
Package the companion offline using the same container with an additional writable
output mount outside the source tree:

```bash
npm run build:companion -- --out-dir /output
```

This produces exactly `paseo-codium-bridge.vsix` and `companion.json`. The packer
uses fixed ZIP timestamps, regular `0644` files, an explicit file list and no
installation hooks. The source tree is not modified. The deployment builder adds
source/build provenance and hashes; generated VSIX files do not belong in Git.

Tests cover URL fidelity, strict RPC/wire validation, pairing expiry and replay,
simultaneous claims, independent windows, request deduplication, stale dirty-state
updates, socket ownership/transport limits, target queues and cursor ranges.

## References

- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)
- [VS Code extension APIs](https://code.visualstudio.com/api/references/vscode-api)
- [Filesystem activation](https://code.visualstudio.com/api/references/activation-events#onFileSystem)
- [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [VSCodium Web Host](https://github.com/VSCodium/vscodium/blob/master/docs/others.md)

Editor Plus was inspected as a reference for Paseo's documented APIs; this plugin
and its companion are independent implementations.
