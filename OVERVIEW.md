Open VSCodium Web inside Paseo or in a browser tab. Embedded mode shares one editor
per workspace, opens linked files without reloading it, and reports unsaved changes.
Capable Paseo hosts open confirmed files directly in that editor and retain it
while backgrounded. Stock hosts keep read-only file previews and their existing
tab lifetime behavior.

Embedded startup checks same-origin access through the authenticated
`/_paseo/ready` helper before allocating a short-lived pairing capability. File
opens use one correlation ID from the host route through pairing, bridge, queue,
execution and acknowledgement. Receipts distinguish a request that was never sent
from one whose outcome is unknown; unknown outcomes are retained briefly, can be
inspected without resending, and are never retried automatically. The companion
reports the active local file inside its verified workspace through the same
coalesced state, so manual tab changes can update a capable host's Files selection
without retargeting the editor. A new paired Codium window closes Codium's own
primary sidebar once, which the user can reopen. This is presentation only and is
not part of the connection identity.

Configure your authenticated Codium HTTPS address and deploy the access helper on
that same origin. Embedding requires the matching protocol 2 companion extension on
the same host and Unix account. See README.md for setup, usage and Paseo's
file-routing and tab-lifetime limitations.
