# Claude custom backends: first milestone (#433)

Local Claude Code usage keeps `source=claude` and the model reported by Claude
Code. That model is a logical slot; it does not identify the gateway's upstream
provider or actual model.

The installed notify hook observes `ANTHROPIC_BASE_URL` at `SessionStart` and
`Stop`. It reads no auth-token/API-key environment variables. URL parsing happens
at capture: only `scheme://host[:port]` survives, with no userinfo, path, query,
or fragment. Unsupported/malformed URLs and absent environment context are
unknown. The default Anthropic origin is known only when explicitly observed.

Observations bracket transcript byte ranges for the same session and file.
Matching observations can attribute one enclosed user turn. A digest of the
enclosed bytes rejects stale observations after transcript rewrites. Changed endpoints,
missing sides, ranges containing multiple turns (missed Stop), subagents without
their own observations, and legacy files remain unknown. `SessionEnd` closes an
interval but never attributes it. Resume starts after existing transcript bytes.

At first ingestion a local append-only decision ledger freezes each usage
record's identity, including unknown. Late hooks, rescans and a changed current
configuration cannot relabel that record. No migration or historical replay is
triggered. Current config is used only for limits display.

New hourly/project queue snapshots and session model/time buckets carry additive
`backend_usage` token subsets. The existing aggregate keys and logical models
are unchanged, so endpoints within one half-hour/session do not overwrite each
other. Old totals without provenance remain untouched; only newly ingested
subsets receive the new contract. Local export/import preserves this metadata.

Custom/unknown subsets contribute no estimated dollars to the known-cost
subtotal. Pricing metadata is explicitly `unpriced`, session costs are marked
partial, and an unknown-only cost displays “Unpriced”, not a free/$0 claim.
Existing Anthropic-attributed subsets retain normal model pricing. With no
Anthropic OAuth token, a configured/observed custom endpoint produces an explicit
“Custom backend — Anthropic limits not applicable” card (English and Chinese).

Out of scope: gateway quota adapters, actual-provider/model discovery, gateway
pricing metadata adapters, inferred free/unlimited service, historical relabeling,
and cloud accounting schema/pricing changes. Gateway origins are local and are
removed before cloud upload. Cloud continues its existing model-based estimates;
this milestone's provenance and unknown-cost contract apply to local accounting.
No release, production migration or deployment is part of this PR.
