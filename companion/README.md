# Paseo Codium Bridge

Companion for [Paseo VSCodium](https://github.com/alexhopeoconnor/paseo-codium).
It opens requested files and reports unsaved state for one embedded Codium window.

Install the VSIX built from the same revision as the Paseo plugin. Both run as the
same Unix user on the same host, communicating through an owner-only local socket.
The extension activates automatically, works in Restricted Mode and needs no
separate configuration. Browser authentication remains with your Codium endpoint.

This companion speaks protocol `2` and requires the matching plugin `0.4.0`. A
peer with a different protocol is rejected instead of being interpreted loosely.
The companion reserves each request ID with its target fingerprint before opening
a file; a duplicate joins the same operation, while conflicting reuse fails without
executing. Lost acknowledgements are never turned into a second automatic open.

It reports the active local file inside its single workspace, as a normalized
workspace-relative path, through the existing coalesced state and snapshot
messages. Non-file editors, files outside the workspace and unsafe paths report
null. Active-editor changes are coalesced rather than sent once per keystroke.

After a successful pairing it closes Codium's primary sidebar once when asked by
the plugin. This is presentation only: the user can reopen it, the preference is
not part of the editor connection identity, and reconnecting the same Codium window
does not close it again. Standalone Codium windows are unaffected.

See the repository README for building, installation and troubleshooting.
