# Paseo VSCodium

Open the current Paseo workspace or file in a separately hosted VSCodium Web IDE. The plugin uses the workspace's actual directory, including linked Git worktrees.

## Setup

Run VSCodium Web independently, with access to the same absolute paths as the Paseo daemon. Protect its browser endpoint with authentication. Then install this plugin on Paseo 0.15.0 or later:

```bash
paseo plugin add github:alexhopeoconnor/paseo-codium
```

Open the plugin's settings and enter its plain HTTPS origin, for example `https://codium.example.com`. Addresses containing credentials, a path, query parameters or a fragment are rejected. The initial empty address leaves the plugin unconfigured; no connection is attempted.

From a workspace, use Command Center → **Open workspace in VSCodium**. Supported files offer **VSCodium** in **Open with**. The panel provides a browser link and a copy-link action. Your VSCodium endpoint handles its own login.

The plugin sends the workspace and requested file path/line in the destination URL. It does not read file contents, run project commands, install language servers, manage the IDE service or store authentication secrets. Its small server entry registers host-scoped settings shared by the host's authorized clients.

## Navigation limits

- The two applications must see matching absolute filesystem paths. This initial implementation targets Unix-style absolute paths.
- Paseo 0.15 selects its built-in panel for file-at-line links, overriding saved associations. A plugin file panel does not intercept every existing link. Choosing the VSCodium panel explicitly preserves the target passed to it.
- A deep link navigates a complete workbench. It does not guarantee seamless reuse of an existing editor tab without reload.
- If any part of a file path contains a colon, the plugin opens the exact file without a line jump. VSCodium's current goto parser interprets numeric colon-separated filename segments as cursor coordinates after URI decoding; percent encoding cannot remove that ambiguity.
- File panels match the extensions and exact filenames declared in `index.client.tsx`; Paseo does not support a wildcard selector.
- Hosted iframe support is implemented but disabled in this release until login, framing policy, clipboard, keyboard and reconnect checks pass. External opening remains available. Embedded edits cannot report unsaved state back to Paseo, so changes must be saved before closing an embedded panel.

VSCodium itself and any installed IDE extensions run with their configured server account's permissions. Keep its Workspace Trust policy and extension selection appropriate for the repositories being opened.

## Development

There are no production package dependencies or manifest preparation commands. Paseo supplies its SDK, React, React Native and Zod and compiles the source when loading it. Host npm is not required for Git/local installation.

The development lock is checked using the pinned Docker image below. Run from this checkout:

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

The tests decode independently generated URLs to check exact workspace/file paths and cursor positions, including reserved filename characters. They also exercise settings validation and the unconfigured state.

The deployed release still needs browser verification against the selected VSCodium build, including authentication, linked-worktree navigation, editing/saving, and persisted plugin settings. Unit tests do not establish those deployment properties.

## References

- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)
- [VSCodium Web Host](https://github.com/VSCodium/vscodium/blob/master/docs/others.md)
- [VS Code workbench URL handling](https://github.com/microsoft/vscode/blob/main/src/vs/code/browser/workbench/workbench.ts)
- [VS Code file/line payload handling](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/environment/browser/environmentService.ts)

Editor Plus was inspected as a reference for Paseo's documented APIs; this plugin is an independent implementation.
