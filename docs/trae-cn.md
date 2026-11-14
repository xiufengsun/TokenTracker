# TRAE CN data discovery and Windows junctions

The `trae-cn` source reads account usage from TRAE's API. It does not scan
project folders or import a CN SQLite database. The separate `trae` reader
supports the international `Trae` / `TRAE SOLO` databases at
`ModularData/ai-agent/database.db` (with an `ai-chat` fallback). CN databases
are deliberately excluded from that discovery; moving a CN project database
or finding `storage.json` does not establish local usage support. The
international SQLite reader projects structured `chat_turn` token counters;
scalar history/context-size snapshots are not billed usage.

On Windows, CN authentication discovery checks these files, in order:

1. `%APPDATA%/TRAE SOLO CN/User/globalStorage/storage.json`
2. `%APPDATA%/Trae CN/User/globalStorage/storage.json`

File reads and discovery follow directory junctions, including a junction at
the app root or at `User/globalStorage`. There is no directory walk that skips
junction entries. A missing target is absent; permission and IO failures now
produce an unreadable-storage warning in foreground sync and `auth unreadable`
in status instead of being silently treated as an uninstalled app.

`TOKENTRACKER_TRAE_CN_HOME` already overrides discovery. Set it to the relocated
app-data root containing `User`, not the project folder, executable directory,
SQLite file, or `storage.json`. This is also how to select the correct signed-in
app when both CN clients are installed. The override does not enable local CN
SQLite import.

Run `tokentracker status` to see the selected auth path, local readability, and
usage opt-in. API sync requires `TOKENTRACKER_TRAE_CN_USAGE=1` and a foreground
`tokentracker sync --source=trae-cn`; background/local-only sync does not send
CN credentials. Readable auth alone does not prove that TRAE will accept it or
return usage. Never share `storage.json`, JWTs, or refresh tokens when reporting
a discovery problem.

Regression tests exercise discovery, auth reads, repeated sync, and privacy
gating through links. They use real junctions on Windows and symlinks on POSIX;
POSIX results do not substitute for testing the reporter's Windows installation.
