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
subsets receive the new contract. On upgrade, existing sync cursors and session
metadata identify the already-accounted byte prefix; a frozen, digest-checked
boundary keeps that prefix outside new attribution during ordinary and forced
rescans. Existing per-record decisions still win. Local export/import preserves
the backend token subsets in queue snapshots.

Custom subsets contribute no estimated dollars to the known-cost subtotal.
Pricing metadata is explicitly `unpriced`, session costs are marked partial,
and a custom-only cost displays “Unpriced”, not a free/$0 claim. Anthropic and
unknown subsets retain normal model pricing: unknown is the provenance of every
default install that never sets `ANTHROPIC_BASE_URL`, of subagent transcripts
(no hooks of their own) and of any turn the hooks did not bracket, so it is not
evidence of a gateway. Pricing it at $0 zeroed all new Claude cost for default
setups; it is estimated at the model rate exactly as before provenance existed. A
configured/observed custom endpoint takes precedence over existing Anthropic
OAuth credentials and live or cached quotas. It produces an explicit “Custom
backend — Anthropic limits not applicable” card (English and Chinese), with
`limits_status=not_applicable` and `cost_status=unknown`, without requesting
Anthropic usage or service status. Backend detection runs before aggregate cache
selection and honors the supplied environment, including `CLAUDE_CONFIG_DIR`.

Out of scope: gateway quota adapters, actual-provider/model discovery, gateway
pricing metadata adapters, inferred free/unlimited service, historical relabeling,
and cloud accounting schema/pricing changes. Gateway origins are local and are
removed before cloud upload. Cloud continues its existing model-based estimates;
this milestone's provenance and unknown-cost contract apply to local accounting.
No release, production migration or deployment is part of this PR.
