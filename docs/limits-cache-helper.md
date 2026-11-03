# The shared limits cache pipeline (`src/lib/limits-cache.js`)

Every network-facing usage-limits provider serves stale bars from a last-good
disk cache when a live poll fails transiently (issue #941). Fifteen providers
shipped their own hand copy of that pipeline before it was folded into one
module; the copies differed almost exclusively in three parameters — the
identity partition key, the field/window list, and the TTL gates. This document
describes the shared pipeline and how each provider expresses its variation.

## The pipeline (invariants)

These are the red lines from issue #941. Every provider configuration must
keep them; the helper enforces them structurally.

1. **Write only on live success.** `write()` refuses error-shaped,
   unconfigured, or windowless records (unless a provider overrides
   `writeGuard`). The stamp is `cached_at: new Date(nowMs).toISOString()`.
2. **Atomic writes.** Same-directory tmp file (`<file>.<pid>.tmp`, mode
   `0o600`) then `rename`. Readers see the previous or the next payload, never
   a torn one. Write failures are swallowed — a cache write must never turn a
   successful live read into a failed poll.
3. **cached_at gates.** An unparseable stamp rejects; a stamp more than 60s in
   the future rejects (clock skew / copied files tolerance).
4. **Reset gating.** A window whose `reset_at` (or codex's unix-seconds
   equivalent) has already rolled over is dropped — serving it would mislead
   after the quota refreshed. A snapshot with no surviving window is rejected
   entirely (`null`), never served as an empty shell.
5. **Undated-window bounds.** Windows without a parseable reset stamp are kept
   only within the global max-age, or within an explicit
   `unknownResetTtlMs` (12h where used) measured from `cached_at`.
6. **Identity partitioning.** A read requires the stored identity to match the
   current one and a write without an identity is refused (fail-closed,
   cursor family) — or, for ark, a mismatch only rejects when the caller could
   establish an identity at all (fail-open). One account's bars must never be
   pinned by another's entry.
7. **Actionable errors punch through.** Auth/config errors pass through the
   assembly untouched — the cache never masks a re-login. The
   `withLimitsCacheFallback` helper encodes this as the `passthrough` hook;
   providers with bespoke classification (devin's status-code classes, gemini's
   token-refresh split) encode it there.

## `createLimitsCache(options)` → `{ path, hasWindow, isWindowUsable, normalize, read, write, clear }`

| Option | Meaning | Used by |
|---|---|---|
| `file` | filename or `({ namespace }) => filename` | qoder partitions by filename |
| `key` | payload wrapper key; `null` = flat payload | ark is flat |
| `fields` | `{ name: kind }`; kinds `string`/`number`/`raw`/`boolTrue` or `{ read, write }` functions | per-provider field lists |
| `windowKeys` | object windows gated per-window by reset stamp | all |
| `sparseWindowKeys` | omitted from payload when absent/dead instead of `null` | qoder `tertiary_window` |
| `windowResetField` | per-window reset field name (`reset_at`) | claude uses `resets_at` |
| `resetTimeMode` | `"iso"` or `"unix-seconds"` | codex |
| `maxAgeMs` | number, `(rawEntry) => number`, or `null` | opencode-go source-dependent; ark none |
| `maxAgeGate` | `"always"` or `"ifNoDatedSurvivor"` | qoder: a future-dated window outlives the global max-age |
| `unknownResetTtlMs` | keep-without-reset bound | antigravity/qoder/ark (12h) |
| `stale` | `true`/`false`/`"byAge"`/`null` (omit) | antigravity has no stale flag; qoder computes from `freshTtlMs` |
| `cachedFlag` | include `cached: true` in reads | antigravity/qoder/ark |
| `source` | `{ const }` or `"provenance"` | ark const; qoder #955 provenance |
| `identityField` / `identityRequired` | entry partition key; fail-closed vs fail-open | cursor family vs ark |
| `writeGuard` | custom `(record) => bool` | ark (normalizer already rejects windowless payloads upstream) |
| `dirOverride` | option name overriding the tracker dir | opencode-go `trackerDir` |

## `withLimitsCacheFallback(slot, hooks)` → servable slot

The standard assembly shape, shared verbatim by cursor, kimi, grok, copilot,
gemini and kiro:

```
configured === false          → pass through
success with windows          → stamp fresh (stale: false, cached_at) and write
                                (generation-gated; resolveWriteIdentity may refuse)
passthrough(slot)             → pass through (auth/config errors)
beforeRead() === null         → pass through (gemini's auth-mode re-validation)
transient failure             → cache.read (replace or overlay merge), else the slot
```

Internal plumbing markers (`cache_identity`, `auth_error`, `config_error`) are
stripped on every return path. Hooks:

- `resolveWriteIdentity(slot)` — identity to write under; falsy refuses the
  write. grok accepts only the fetch-carried identity; kiro/gemini re-read the
  current credential and refuse on a mid-flight account switch.
- `resolveReadIdentity()` — failure-only re-derivation (the outer timeout race
  strips the fetcher's own identity field).
- `beforeRead()` — override `{ nowMs, identity }` (kiro reads against the wall
  clock) or `null` to veto the fallback entirely.
- `merge` — `"replace"` (default) or `"overlay"` (copilot's otel fields and
  kiro's credits sidecar ride on the failed slot; cached entry wins only the
  limit fields).
- `markers` — the plumbing markers to strip.

Providers with bespoke assembly (antigravity's reauth-flagged cache serve,
claude's dual-source pickNewest + fresh pre-fetch gates, codex's
REFRESH_TOKEN_EXPIRED punch-through, opencode-go's auth passthrough, devin's
windowless-success cache clear) keep their hand-written assembly and call the
factory's `read`/`write`/`clear` directly — the pipeline invariants live in the
factory either way.

## Migration state

All fifteen hand copies now sit on the shared pipeline:

- usage-limits.js: antigravity, claude, codex, cursor, opencode-go, kimi, kiro,
  grok, copilot, gemini, devin
- qoder-limits.js: qoder + qoder-cn (namespace files)
- ark-coding-plan-limits.js / ark-agent-plan-limits.js

The per-provider fallback tests (`test/*-limits-cache-fallback.test.js`) are
unchanged and act as the behavior-preservation oracle; `test/limits-cache.test.js`
covers the pipeline itself. Adding provider #16 is now a constants block plus a
factory call — the issue's "9th and 10th hand copy" problem stays solved.
