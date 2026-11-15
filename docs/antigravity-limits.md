# Antigravity quota credentials

TokenTracker reads Antigravity quota with credentials from local token files,
macOS Keychain, or Linux Secret Service. An expired access token can be renewed
with its refresh token without keeping Antigravity or `agy` open. Revoked refresh
tokens still require signing in again.

When an `agy` CLI is running, TokenTracker reads the CLI's saved login with
`agy --settings '{"disableSlashCommands":false}' -p /usage --output-format json`.
Only the default per-user installation is executed: `~/.local/bin/agy` on macOS
and Linux, or `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows. On Windows it can
also use the installed CLI when the process is closed. This read-only command is used only
with agy 1.1.11 or newer; slash-command handling is enabled for that invocation
without changing the user's settings. Older or unavailable CLIs fall back to the
existing credential, language-server and cache paths.

The shared Gemini and Claude/GPT weekly and five-hour windows are displayed when
reported. If the account also reports a Gemini 4 Argon weekly bucket, it appears
separately as **Argon 7d**. Missing buckets are not treated as empty or full.

On Linux, keyring discovery requires `secret-tool` on PATH and a running,
unlocked Secret Service provider, such as GNOME Keyring. Install the command with
`sudo apt install libsecret-tools` on Debian/Ubuntu or
`sudo dnf install libsecret` on Fedora. KWallet must expose the Secret Service
interface. Headless sessions may lack a session D-Bus connection or an unlocked
keyring.

TokenTracker looks up the entry with service `gemini` and username
`antigravity`. After refreshing a keyring token, it saves the renewed access token,
expiry, and any rotated refresh token back to that entry. It preserves the entry's
JSON/base64 format and sends the secret to `secret-tool` through stdin.

If the command is missing, the entry cannot be read, or the lookup times out,
TokenTracker uses any available
file credentials, local language server, or last-good quota cache. A keyring
lookup cannot spend more than two seconds or the remaining provider budget.
Keyring writes also have a two-second deadline and stop when the provider request
is cancelled.

To skip all Antigravity credential reads and quota requests, set
`TOKENTRACKER_DISABLE_ANTIGRAVITY_QUOTA=1`. Transcript-based token tracking
continues to work.
