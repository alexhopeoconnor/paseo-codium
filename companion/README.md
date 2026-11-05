# Paseo Codium Bridge

This companion connects an individual Codium window to its Paseo workspace panel.
It activates when Paseo opens its temporary, read-only `paseo-codium-session` URI.
It opens requested files with Codium's editor APIs and reports editor readiness
and unsaved state through an owner-only local Unix socket. Authentication remains
in the browser and Authentik; this extension stores no browser credentials.

The companion and Paseo plugin must run as the same Unix user on the same host.
It works in Restricted Mode without executing repository configuration or
trusting the workspace. It does not install language servers or run shell commands.

Build the VSIX with the repository's pinned Docker toolchain and install the
verified artifact through the tracked workstation tooling. The root README
describes protocol compatibility, lifecycle limitations and verification.
