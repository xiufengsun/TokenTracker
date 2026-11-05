# Cursor connection

Recent Cursor releases encrypt their locally stored access token. TokenTracker skips that encrypted value and does not decrypt it or read OS keychains or browser cookie databases.

In the local dashboard, open Usage & Limits and choose **Connect** next to Cursor. Complete sign-in on Cursor's website and return to TokenTracker. A successful connection refreshes quota data; the next usage sync imports the CSV events available from Cursor.

The browser flow uses Cursor's client login endpoints (`/loginDeepControl` and `/auth/poll`) with a random PKCE verifier. These are internal client endpoints, not a documented third-party OAuth integration. The verifier stays in the local server's memory, expires after ten minutes, and is discarded when the flow ends. Cancellation or failed validation preserves any previous connection.

After verifying the new session against Cursor's usage-summary endpoint, TokenTracker stores only the access token in `~/.tokentracker/tracker/cursor-session.json`. On macOS and Linux the file is created with mode 0600. It is a local credential file, not an encrypted vault. The refresh token is discarded. The local API exposes connection status and expiry, never the token or verifier. The same file supplies both quota reads and independently launched sync processes.

An expired connection asks you to reconnect. Disconnect removes TokenTracker's copy; it does not sign you out of Cursor or revoke the session at Cursor. Older Cursor installations with a plaintext local token keep their existing detection path. A saved but invalid TokenTracker connection never silently switches to a different local account.

The cloud website cannot connect to the local credential store. Use the installed app or local CLI dashboard. Credentials are not included in usage uploads.
