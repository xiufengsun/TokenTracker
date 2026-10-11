# Antigravity quota credentials

TokenTracker reads Antigravity quota with credentials from local token files,
macOS Keychain, or Linux Secret Service. An expired access token can be renewed
with its refresh token without keeping Antigravity or `agy` open. Revoked refresh
tokens still require signing in again.

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
