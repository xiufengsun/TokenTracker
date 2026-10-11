---
repo: TokenTracker
layer: fullstack
module: release-review
severity: S2
design_mismatch: yes
detection_gap: yes
---

# Issue and PR review — 2026-10-11

The review started with 35 open issues and nine open PRs. Seven existing PRs were accepted. Two remain open because their current implementations are not release candidates. This report distinguishes shipped fixes, partial improvements, missing evidence, and feature work; an open item is not represented as solved.

## Accepted PRs

| PR | Review and disposition |
| --- | --- |
| [#770](https://github.com/xiufengsun/TokenTracker/pull/770) | Multica's flat pi-sessions directory is discovered without duplicate paths. Existing pi accounting remains authoritative. |
| [#761](https://github.com/xiufengsun/TokenTracker/pull/761) | Reviewed dashboard dependency and lockfile update; prior platform CI passed. Integration tests and build retain these versions. |
| [#767](https://github.com/xiufengsun/TokenTracker/pull/767) | Antigravity refresh and Secret Service discovery: bounded subprocesses, cancellation, stdin for secret writes, account-change protection and preserved cache fallback. |
| [#764](https://github.com/xiufengsun/TokenTracker/pull/764) | Accessible synchronized leaderboard scrollbar, explicit quota refresh feedback, bulk provider visibility and account/region-aware ZCode paid plans and reset inventory. |
| [#777](https://github.com/xiufengsun/TokenTracker/pull/777) | Repaired before merge. Removed the regression that discarded the first fallback and the assignment to a const variable. SQLite is now read per event, retaining timestamp, model and cached tokens. Compaction checkpoints are excluded and import archives seed dedup. Repeated scans and appends are tested. All platform CI and CodeQL passed on the repaired head. |
| [#769](https://github.com/xiufengsun/TokenTracker/pull/769) | Verified Spark-X2.5 promotional prices against the official model square; scope is AStudio. Local and all five cloud pricing tables agree. Deployed source was read back and compared byte-for-byte before merge. |
| [#632](https://github.com/xiufengsun/TokenTracker/pull/632) | Reconciled with current main, preserving Cloud changes, version files, copy and parser tests. CN and international response/cursor identities stay separate; undisclosed international auto routing stays unpriced. Targeted tests, all platform CI and CodeQL passed. Five cloud functions were deployed and source-verified before merge. |

## PRs held

| PR | Concrete blocker |
| --- | --- |
| [#569](https://github.com/xiufengsun/TokenTracker/pull/569) | The new unclassified-input accounting predates current compact daily/summary/model wire formats and Cloud historical archives. Merging conflicts alone does not propagate the column through those contracts or cold storage. Local and cloud cost aggregation also need to preserve current priority subsets and provider-reported cost. The migration and deployment must include these paths, with cold/hot parity and authorization regressions, before client release. The exploratory local merge was aborted; no production schema was changed. |
| [#627](https://github.com/xiufengsun/TokenTracker/pull/627) | A draft containing unfinished account credential switching, process/session management and marketing work. It conflicts with current main; its last main test/macOS checks failed and its CodeQL result is failed. It needs separate completion and current-platform/security validation before converting it to a release candidate. |

## All issue dispositions

| Issue | Result / next required evidence |
| --- | --- |
| #776 | Fixed: SQLite passive accounting and lifecycle triggering, with legacy JSONL compatibility and import dedup. |
| #775 | Open: current Qoder CN CLI authentication and quota API contract are needed. A browser-use endpoint/token is not established as a quota API. |
| #774 | Fixed: PowerShell-safe executable/script literals, current Node executable and replacement/dedup of legacy hooks. Real PowerShell tests cover spaces, apostrophes and dollar signs. Gemini uses the same command builder. |
| #773 | Partial: removed duplicate full-window browser blur and coalesced/deduplicated pet context updates. User hardware frame timings and shell responsiveness still need verification; no claim that every source of stutter is eliminated. |
| #771 | Open feature: OpenCode usage already has v2 support; the separate resumable session-browser adapter, metadata and UI integration are still required. |
| #768 | Open: mixed-DPI minimize/restore requires the affected monitor configuration and window/composition diagnostic evidence. |
| #766 | Partial: k3-256k now shares the established k3 price locally and in the cloud. Missing kimicoding usage requires a redacted numeric wire event/version and the actual storage layout; a floating preview alias is not assigned an invented model price. |
| #765 | Partial: session transcript footprint and bytes per 1K lifetime tokens now appear in the browser. POSIX allocated blocks and Windows logical file size are labeled. Shared databases, caches and project artifacts are excluded. Growth history and additional provider session adapters remain feature work. |
| #763 | Fixed by #764. |
| #762 | Fixed: distinct Opus 5.5 / Sonnet 5.5 rates, corrected Sonnet 5 rates and exact lookup/boundary ordering. Current Claude parsing already separates thinking from output; removing its reasoning charge would underbill and was rejected by the regression test. |
| #756 | Open: same quota contract gap as #775. The supplied new desktop evidence does not establish token counters or a usable quota RPC. Manual cookie fallback remains available. |
| #744 | Open: remaining route IDs need provider-scoped official pricing or resolved-model identity. Internal auto-review/reserve/default aliases are not evidence of a fixed public model. Known catalog matches remain supported. |
| #741 | Open: Kimi Desktop/Work needs a versioned local numeric usage storage contract. |
| #739 | Fixed: Usage Overview's existing splits are joined by public leaderboard profile per-model input/output/cache-read/cache-write/reasoning breakdowns. Backend and profile UI are compatible with older responses. |
| #735 | Open: reported expired Claude credentials require an affected-account reauthentication/configuration check. Website login does not validate the local CLI OAuth credential. |
| #728 | Open: LTSC startup/WebView2 version and sanitized host log are needed to distinguish server startup from rendering failure. |
| #726 | Open: supplied exact and combined pairs confirm SDK mirroring but contain no shared request identity. A dedup contract must also preserve OmO usage when its underlying Claude transcript is not available. No counter/time heuristic was used to delete history. |
| #724 | Open: Cowork needs a readable per-request numeric usage source and overlap semantics with Claude SDK logs. |
| #722 | Open feature: shared native connection mode, native consumers and multi-instance semantics need implementation and authentication/ownership tests; changing only the WebView URL does not satisfy the request. |
| #720 | Open external dependency: Kaspersky behavior-detection review/signing evidence is needed; a matching file hash does not prove the vendor has resolved its detection. |
| #714 | Open: historical source retention, missing date range and expected/actual totals are needed. No history reset was performed. |
| #712 | Open: reduced device/hour re-uploads require the two devices' original queue/migration evidence before restoring old values. Restoring an earlier overcount would be a data error. |
| #698 | Open: Kiro snapshots and request IDs are not in one-to-one correspondence; the context limit, compaction baseline and missing-request semantics still need a defensible estimator. Current estimates remain labeled. |
| #675 | Open affected-account check: existing fresh local snapshot fallback and 429 cooldown remain; an account without a usable snapshot is not proved fixed. |
| #664 | Open: affected WebView2 runtime/GPU/host diagnostic evidence is still required. Composition changes are not represented as a verified fix for this gray-panel report. |
| #656 | Open upstream limitation: an ephemeral Codex side conversation without a persisted usage record cannot be counted reliably. Confirm whether the affected version writes a rollout. |
| #648 | Open hardware check: existing renderer defaults and explicit environment overrides were reviewed; NVIDIA/KDE reproduction is still required. |
| #647 | Open upstream data: reported Qoder free-model rows have zero counters; credits cannot be converted into tokens without a documented rate. |
| #631 | Fixed by #632 after verified cloud rollout. |
| #619 | Open feature: quota history/API-equivalent cost by reset window needs a defined estimate and boundary precision; quota percentages are not a subscription bill. |
| #618 | Already implemented: current OpenCode reader supports legacy and session_message/session_v2 schemas; integration fixtures pass. Eligible to close as completed. |
| #592 | Fixed: session date filters now sum in-range Codex usage buckets, including local calendar boundaries and descendant own/combined totals. Lifetime view retains the full total. The earlier queue hot-session fix remains intact. |
| #568 | Open integration proposal: TokenTracker tracks usage; adding an inference router needs a tracking/quota data source rather than a new chat completion endpoint. |
| #499 | Open: CLI counters are not established; Desktop table definitions, metrics semantics and migration identity are needed before adopting the proposed reader. |
| #433 | Open: custom-backend quota and per-interval provenance are separate from token tracking. The agreed two-sided observation contract has not yet been implemented as an end-to-end integration. |

## Validation and rollout

- CLI suite: 3,934 passed, zero failed, 57 platform/precondition skips (3,991 total). SQLite test tools were verified with the CI-pinned SHA3-256. Host AppData isolation was repaired; Cursor alternate-home credential reads no longer cross into the default Windows profile.
- Windows Release build: zero warnings/errors. Native unit tests: 119 passed, one platform skip.
- Focused session analytics: 44 passed, including repeated usage events, cross-day deltas, Shanghai date boundaries, footprint size and lifetime preservation. Real PowerShell execution passed.
- Full dashboard suite initially had 1,527 passes and one five-second timeout under concurrent build/test load; the affected leaderboard suite passed all 18 tests on isolated rerun. Full-suite verification with bounded worker count follows before release acceptance.
- Copy registry, Chinese coverage, UI string guard, architecture guard, managed versions and generated bot-frame validation passed. The missing retrospective index was restored with this review and the validator is run again.
- Five pricing/account/profile edge functions were built, deployed and read back byte-for-byte. Private recovery snapshots are under the ignored worktree `.tmp/edge-recovery/`; no production schema, customer usage or payment configuration was changed.

Official rates: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [iFlytek model square](https://maas.xfyun.cn/modelSquare?ch=MaaS-jgkol-6B2D). No guarantee of universal perfection is inferred from tests or CI; unreproduced environments and held PRs remain explicit above.
