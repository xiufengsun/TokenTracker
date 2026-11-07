# Claude Desktop Cowork usage-ledger bridge (opt-in, macOS)

Related to #724: Claude Desktop can write per-turn Cowork usage to local daily
NDJSON ledgers. This experimental bridge makes those counters available through
TokenTracker's existing Claude parser. It is a manually invoked script, not
automatic discovery in the released desktop app, and it does not count ordinary
Claude web/desktop chat.

## Data-source evidence and scope

The schema below was observed with Claude Desktop **3.6556.2 on macOS**. The
bridge was exercised with TokenTracker 1.4.12 and tested against the 1.4.13
checkout. The source is an observed local file format, not a documented stable
Anthropic API. Windows paths and other ledger versions have not been verified.

The supported locations are:

```text
~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<profile>/usage-ledger/YYYY-MM-DD.ndjson
~/Library/Application Support/Claude-3p/local-agent-mode-sessions/<account>/<profile>/usage-ledger/YYYY-MM-DD.ndjson
```

This is a **synthetic example** with invented identifiers and counts, preserving
the observed schema. No real conversations, account IDs, or usage history are
included:

```json
{"v":1,"ts":1792999512000,"surface":"cowork","origin":"turn","sessionId":"example-session","isError":false,"models":{"claude-opus-5-5":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":1000,"cacheWriteTokens":200,"webSearchRequests":0,"cost":{"usd":0.01,"basis":"list"}}},"tools":{}}
```

Each `models` entry is usage for that turn and model. The bridge imports only
`v: 1`, `surface: cowork`, `origin: turn` records with valid timestamps and
nonnegative safe-integer counters. Error turns with recorded usage still count.
It does **not** read SDK audit transcripts: their result-level `modelUsage` can
be cumulative across turns, and summing those snapshots inflates usage.

| Ledger field | Claude parser field | Meaning |
| --- | --- | --- |
| `inputTokens` | `input_tokens` | Non-cached input |
| `outputTokens` | `output_tokens` | Output, including reasoning when present |
| `cacheReadTokens` | `cache_read_input_tokens` | Cache reads |
| `cacheWriteTokens` | `cache_creation_input_tokens` | Cache writes |

For the synthetic example, total usage is `100 + 50 + 1000 + 200 = 1350`.
Reasoning is not separately reported by this ledger; no additional reasoning
tokens or human-message counts are invented. Ledger costs and tools are not
imported; displayed cost follows TokenTracker's existing model pricing and is
not a subscription charge.

## Run from a checkout

Use a TokenTracker checkout with dependencies installed (Node 24 matches CI):

```sh
npm ci
node scripts/cowork-local-adapter.cjs
```

The script prefers the adjacent checkout's runtime. If copied outside the
checkout, it can also use the runtime in `/Applications/TokenTracker.app` or
`~/.tokentracker/tracker/app`, with its dependencies present. These are internal
runtime interfaces, so compatibility with future versions must be rechecked.
The parse-failure retry guarantee requires the runtime from this checkout:
older packaged runtimes (including 1.4.12/1.4.13) do not honor the adapter's
`failOnClaudeParseFailure` context option. Use the checkout until an updated
runtime is released.
The script does not modify the application bundle or install a scheduler.
Rerun it after Cowork activity, or invoke it with a scheduler you configure.
It scans all retained daily ledgers on each run; large histories increase work.

On its first run it registers this additional Claude scan root in
`~/.tokentracker/tracker/config.json`:

```text
~/.tokentracker/cowork-adapter/claude
```

It writes usage-only JSONL under that root's `projects/cowork/` directory,
then performs a Claude-scoped local sync. Imported usage appears under the
existing **Claude** source, without a separate Cowork category. Existing scan
roots and unrelated settings are preserved. A busy native sync defers import
until the next invocation. A refresh failure exits nonzero and remains pending
for retry; successful no-op runs can be silent.

The bridge's refresh disables cloud upload for that invocation without changing
the saved cloud-sync preference. Imported aggregates enter the normal local
queue; a later normal TokenTracker sync can upload them if cloud sync is enabled.
This bridge does not provide a permanent per-source cloud exclusion.

## Integrity and privacy

- Only model IDs, timestamps, counters, hashed event/session IDs, and fixed
  parser metadata are written. Prompts, replies, tools, account/profile IDs,
  raw session IDs, and credentials are not copied.
- An event/model key hashes `(sessionId, ts, origin, model)`, without the source
  path. Identical copies across profiles or the two supported roots count once.
  Conflicting counters for the same key stop the batch before publication.
- Generated files are append-only and form the deduplication journal. Repeated
  import, cursor rebuild, and source-ledger removal retain the same totals.
- Incomplete source lines wait for a terminating newline. Interrupted output
  fragments are isolated with a newline before retry, without truncating bytes
  an existing parser cursor may have consumed.
- The bridge uses its own run lease and TokenTracker's native sync/config
  leases. A refresh-pending marker is written before publication, so a failed
  refresh is retried even when no new events remain to import. The bridge opts
  into propagating Claude parser errors before the sync commits its cursors;
  ordinary sync callers retain their best-effort provider handling.

Deduplication is specific to these ledger records. Manually importing the same
Cowork SDK audit transcripts through another root can double-count usage because
their message/session identifiers differ. Do not enable both paths. A future
native Cowork importer will need to account for this bridge's registered root.

To pause imports, stop invoking the script (and disable any scheduler you added).
Keep the generated journal and registered root to retain rebuildable history.
Deleting the journal or removing the root is not a supported history-reset
operation; queue/cursor rebuilds need coordinated handling.

## Verification

The tests use synthetic temporary homes and the real Claude parser, sync command,
and ground-truth rebuild. They cover counter mapping, multiple models, repeat
imports, duplicate profiles, source rotation, malformed/partial records,
conflicting counters, interrupted output, lock contention, config preservation,
scoped sync, and failed-refresh recovery. A stream-error regression exercises
the real parser after a complete row has been read, verifies recovery with an
unchanged ledger, and checks that retry/rebuild totals agree without duplication.

```sh
node --test test/cowork-local-adapter.test.js
```
