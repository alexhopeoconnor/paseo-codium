Open your current Paseo workspace or file in VSCodium Web, using the exact checkout or Git worktree directory. A workspace action and supported file panels provide an editor link and a copy-link action.

Run VSCodium Web separately with access to the same absolute Unix paths as your Paseo host, and configure its HTTPS address in this plugin's settings. Its existing login protects access. The plugin requires Paseo 0.15.0 or later.

Workspace and file paths, with a requested line when available, are sent in the editor URL. The plugin does not read file contents or execute project commands. Connection settings are shared across authorized clients of the Paseo host.

Paseo's built-in panel still handles existing file-at-line links; choose the VSCodium panel explicitly where offered. A link may open or reload a whole IDE window. File paths containing colons open without a line jump because of VSCodium's goto parser. Embedded presentation is disabled pending deployment-specific browser verification.
