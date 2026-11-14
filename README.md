# Paseo VSCodium

> Developed and supported for the [workstation fork](https://github.com/alexhopeoconnor/paseo/tree/workstation).
> Build and install locally from reviewed source. Binary release assets are not published.

Open a separately hosted VSCodium Web IDE from Paseo. Embedded mode uses one
editor per workspace; file links navigate that editor without reloading it.
Capable Paseo hosts dispatch confirmed file opens directly to that editor and
retain it while backgrounded. Stock hosts keep a read-only file preview alongside
the editor. External mode opens Codium in a browser tab.

Embedded startup first checks authenticated access through a same-origin
`/_paseo/ready` helper, then allocates the two-minute pairing capability and
mounts the editor. File-open receipts carry one correlation ID through the host
route, access check, pairing, bridge, queue, execution and acknowledgement. They
distinguish a request that was never sent from one whose outcome is unknown;
unknown outcomes are never retried automatically.

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

Build the plugin and companion from that same revision. The current pair is plugin
`0.4.0` with companion `alexhopeoconnor.paseo-codium-bridge@0.2.0`, protocol `2`.
Install its verified VSIX with Codium's server launcher and the same data and
extension directories as the running service. Protocol 2 requires both components
from the same reviewed revision; an older peer is rejected with a generic
incompatible-version error. Save edits and close editor sessions before updating
either component.

The Codium endpoint must serve the reviewed static access helper at
`/_paseo/ready` behind the same authentication as the IDE. The helper receives a
128-bit nonce in the URL fragment, posts one `paseo-codium-access-ready` message to
the configured exact Paseo origin, and never receives credentials. It proves
same-origin authenticated access only, not Codium backend or companion health.

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
- Embedded startup checks Codium access before it pairs. If access is unconfirmed,
  use **Sign in to editor** to open only the helper page in a top-level window, or
  **Check again**. Returning to Paseo starts a new access check and pairing; a
  timeout is an unconfirmed access result, not an authentication verdict.
- A new paired Codium window closes Codium's own primary sidebar once, so the
  editor opens with more room. Reopen the sidebar from Codium at any time. The
  **Codium primary sidebar** setting applies to newly paired windows, is not part
  of the connection identity, and never reloads the editor. Standalone Codium
  windows are unaffected.
- Saving connection settings leaves open editors unchanged until **Apply changed
  connection settings**. Pending files wait for the intended connection and expire
  after five minutes. A full browser refresh clears pending requests.
- Dirty or unknown editors require confirmation before closing, reconnecting or
  changing connection. Hosts with `workspacePanelCloseProtection: 1` request a new
  paired-window snapshot at close time, so focusing a clean editor does not mark it
  modified. Routine display state uses the cached heartbeat poll instead: every two
  seconds while the editor panel is visible and every fifteen seconds while hidden,
  with an immediate refresh when the panel or browser becomes visible again. The
  five-second companion heartbeat and fresh close snapshot do not depend on this
  display poll. Stock hosts retain conservative focus protection. Save files in
  Codium before confirming a protected close.
- Hosts advertising `confirmedFileOpen: 1` send files only after confirming the
  viewer choice, without an intermediate file tab. One request ID is the
  correlation ID for the receipt through routing, queueing, execution and
  acknowledgement. Duplicate delivery joins the same receipt; reusing the ID for a
  different target fails without executing. Cancelling a request before dispatch
  is reported as not sent. Cancelling after dispatch is best effort and leaves the
  outcome uncertain rather than claiming the editor did not run.
- An unknown outcome, including a lost acknowledgement or disconnect after the
  request was written, is retained for fifteen minutes and can be queried by its
  request ID. A failed or unconfirmed open shows the correlation ID, current
  outcome and diagnostic stage with **Check outcome**. That action only reads the
  retained receipt; it never resends the file. A null or expired receipt is shown
  as unknown, never as not sent. The plugin never reuses an unknown identity for an
  automatic retry; open the file again to create a new intentional request. Receipt
  memory is bounded and process-local, so it is not a crash exactly-once guarantee.
- Hosts advertising `workspacePanelRetention: 1` retain mounted embedded editors
  independently from unsaved-change protection. The retained editor keeps the same
  iframe and browser window. Close the editor explicitly to release it; retention
  does not survive browser refresh or process termination.
- A host may optionally provide request-bound panel placement, actual panel
  visibility, bounded text-file classification and scoped Paseo-tree reveal. The
  plugin uses those only when advertised and otherwise keeps the reviewed
  extension/filename selectors and focus-based fallbacks. Codium reports its active
  local file, workspace-relative, in the existing coalesced state/heartbeat. Actual
  active-file changes, including manual tab changes, ask a capable host for a
  passive Files selection without opening Files or changing focus. **Reveal in
  Files** is explicit and targets the current observed active file; null, outside
  the workspace, non-file or unknown active files disable it. Neither action opens
  another editor tab, and a reveal after a delayed open is a fresh panel-scoped
  request rather than the already-settled host file-open identity.

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
- The companion reports only an active local file inside its single verified
  workspace. Non-file editors, files outside that workspace and unsafe relative
  paths report null, so they cannot drive a Files reveal.
- The access helper must be deployed at the same Codium origin and protected by the
  same forward authentication. Without it, embedded startup stays unconfirmed and
  does not allocate pairing. The helper does not establish IDE backend health,
  companion installation or bridge availability.
- Access checks in the automated suite use a synthetic browser frame. They do not
  prove a real Firefox/forward-auth session, cookie policy or deployed helper.
- Receipts are bounded diagnostic memory, not a durable transaction log. A process
  crash, expired receipt or evicted terminal receipt can make an outcome unknown
  again; the plugin reports that as unknown and never as not sent.
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
