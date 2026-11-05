# Paseo Codium Bridge

Companion for [Paseo VSCodium](https://github.com/alexhopeoconnor/paseo-codium).
It opens requested files and reports unsaved state for one embedded Codium window.

Install the VSIX built from the same revision as the Paseo plugin. Both run as the
same Unix user on the same host, communicating through an owner-only local socket.
The extension activates automatically, works in Restricted Mode and needs no
separate configuration. Browser authentication remains with your Codium endpoint.

See the repository README for building, installation and troubleshooting.
