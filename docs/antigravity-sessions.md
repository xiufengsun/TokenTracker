# Antigravity sessions

Antigravity appears in the local Sessions browser alongside the other tools.
The list supports project, model and date filters. Open a row for model/token
breakdowns and estimated API-equivalent cost. No prompt, reply, tool argument or
command output is retained in the sidecar or returned by the session API.

## Data and precision

- Scan `~/.gemini/{antigravity,antigravity-ide,antigravity-insiders,antigravity-cli}`.
  Usage and Sessions honor the same `GEMINI_HOME` and Windows/WSL install selection.
- A brain transcript and its matching `conversations/<cascade-id>.db` represent
  one session. Prefer the transcript when available and join it to native usage;
  also discover CLI databases with no transcript.
- Native `ModelUsageStats` field 1 is a model enum, field 2 is uncached input,
  fields 3/9/10 are total/thinking/visible output, field 4 is cache write, and
  field 5 is cache read. Thinking is counted once, separately from visible output.
- Both views share the decoder and normalization. Extractor revision 2 repairs
  previously parsed Antigravity contributions on the next local sync; repeated
  sync must not append another correction. It preserves the existing legacy
  baseline rules rather than claiming history from an unprovable old ledger.
- A transcript without native counters keeps the existing text-length estimate
  and is marked partial. A database with no model calls can still appear in
  Sessions, with token/cost values shown as **Not recorded**.
- Workspace metadata is read when present. The CLI's documented
  `cache/last_conversations.json` can supply the working directory. Titles are
  currently unavailable when no explicit supported title metadata exists.
  A missing, partial or unreadable workspace cache leaves the path unavailable
  without discarding valid native usage. `status` recognizes db-only CLI installs.
- Event timestamps and start/end times do not prove active work, API latency or
  generation speed; those performance estimates remain unavailable.
- Database/WAL changes invalidate cached rows. A failed read retains the last
  complete Antigravity batch and leaves a retry marker. WSL reads use a local
  database-plus-WAL snapshot.

## Resume

CLI rows offer **Copy resume command**:
`agy --conversation <cascade-id>`. Run it in the session's original environment
and working directory. The command is displayed in session details too.
Only CLI-origin rows offer it; the App/IDE conversation import flow is separate.
Ids pass the same shell-safe validation as the other session sources.

## Compatibility

This integration reads native SQLite and existing brain JSONL logs offline.
Legacy encrypted `.pb` conversations without either source are not decoded.
No Google OAuth token, quota endpoint or running language-server RPC is needed.

## Validation

Regression coverage checks native field mapping, cache writes, Usage/Sessions
parity, transcript/database deduplication, db-only CLI discovery, unavailable
usage, command safety, privacy, repeated sync, extractor migration and
last-complete-snapshot recovery, long transcripts, optional workspace cache
corruption and db-only install detection. UI coverage checks filtering, token details
and copying the CLI command.
