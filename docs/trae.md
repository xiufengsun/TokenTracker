# TRAE international local usage

The `trae` source reads local usage from international TRAE and TRAE SOLO.
It is separate from `trae-cn` and makes no vendor API calls.

## Setup

Run `tokentracker sync`. The reader decrypts the database with TRAE's shared
SQLCipher application key, so no account credential is needed.

You can override the defaults with these environment variables:

- `TOKENTRACKER_TRAE_SQLCIPHER_KEY`: a different 64-character hexadecimal key.
- `TOKENTRACKER_TRAE_HOME`: the application-data root.
- `TOKENTRACKER_TRAE_DB`: a specific database or an existing plaintext SQLite
  export.

On Windows, the default roots are `%APPDATA%/Trae` and `%APPDATA%/TRAE SOLO`.
On macOS, they are `~/Library/Application Support/Trae` and
`~/Library/Application Support/TRAE SOLO`. Linux checks `$XDG_CONFIG_HOME`
(or `~/.config`) for the same directory names, though the Linux application
layout has not been verified.

Under each root, the reader looks for `ModularData/ai-agent/database.db`
before the older `ModularData/ai-chat/database.db`. Automatic discovery skips
CN directories and `database_decrypted.db` siblings, which may be stale.

## Accounting and limitations

For a turn with several model requests, TRAE records whole-turn prompt and
completion totals, but its cache and reasoning fields describe the final
request. The reader prices that request's split. The rest of the turn's prompt
tokens have no cache split, so they count toward `total_tokens` but no priced
column, and TRAE cost is partial; the dashboard says so beside the totals.
In agent sessions, where most prompt tokens belong to earlier requests, the
displayed cost can be a small fraction of what those tokens would cost.
Completion tokens stay priced, since output costs the same with or without a
cache hit. Older Gemini records with omitted
thoughts or duplicated cache-write counters are repaired and marked estimated.
Cost figures use TokenTracker's model prices, not a vendor bill.

Corrections replace earlier contributions, even when the model or timestamp
changes, and turns copied between installations are counted once. Deleting
local history does not remove usage already collected. Manual sync reports
records it skips because their usage is malformed or ambiguous.

## Privacy and read failures

The SQL query returns only token counts, model names, timestamps and opaque
turn/session identifiers, and the reader hashes identifiers before saving them.
No decrypted copy of the database is written to disk.

An active rollback journal or an oversized WAL index produces a retry
diagnostic. If TRAE is still writing, retry after the current turn finishes.
If an installation cannot be read, sync reports the error and keeps its
previously collected usage; other TRAE installations still sync.
