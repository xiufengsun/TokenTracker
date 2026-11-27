# Import and verify a sealed D1 snapshot

The input is the completed SQLite image and its JSON receipt from `rehearse-d1-volume.py`. Finish refreshing derived data and serializing identities first. Keep the source file closed and immutable throughout the transfer. The destination must be a newly created, unbound D1 database owned by the intended account. Keep application writers and schedules off that database until final verification.

From the migration checkout, use a D1-edit token already in the environment:

```sh
python3 cloudflare/scripts/import-verified-sqlite.py \
  --source "$TT_SQLITE_IMAGE" --receipt "$TT_SQLITE_RECEIPT" \
  --account "$TT_CF_ACCOUNT_ID" --database "$TT_EMPTY_D1_ID" \
  --expect-name "$TT_EMPTY_D1_NAME" --chunk-mib 12 --page-rows 10000 --readers 4
```

For the locally authorized `cf` session, supply `--cf-oauth-file` pointing at its private OAuth profile. The script reads the short-lived token in process, enforces file ownership and permissions, and invokes `cf auth whoami` when it needs a refresh. API tokens, financial values, SQL chunks and presigned object URLs stay out of logs. The transfer keeps chunks in memory.

The script compares the database identity with the expected name, checks local integrity and foreign keys, checks row counts against the completed restore receipt and records the file SHA-256 in the empty remote database. It installs schema and indexes first, loads rows in foreign-key order, then creates triggers and views. Each D1 import file includes a checkpoint in the same transaction. Rerunning the identical command resumes after verified checkpoints. The file hash, chunk size and completed prefix must match. If another import has the database temporarily locked, wait for Cloudflare to release it, then rerun. The table `tt_migration_import_parts` stores only chunk digests and source identity. It can remain for audits.

The final verification queries remote D1 directly over up to four persistent HTTPS connections with gzip responses. A bounded primary-key range selects each page. Integers are converted to text within D1 before JSON serialization; text, blobs, real and NULL values retain type tags. The verifier hashes the typed values in primary-key order, compares table counts and schema definitions, and includes `rowid` for quarantine records with no declared primary key. Use the same command with `--verify-only` for an independent reread. The scan covers every field in every table and does not modify remote application rows.

Each completed upload prints cumulative API calls, bytes transferred, SQL execution time and D1-reported rows read and written for that invocation. Verification prints one digest per table and its final read/write meter. Preserve redirected stdout in a private operations directory for a run spanning multiple invocations. The counters describe the API calls in that process. A checkpoint already present at startup does not reveal billing counters for a lost response in a previous invocation. Cloudflare organization usage is the billing reference.

The two isolated Cloudflare trials on 2026-11-24 used synthetic data. Both stopped after part 2, then resumed. The first checked five rows across three tables, a self-foreign-key, an index, a trigger and a view, including signed 64-bit limits, decimal text, a BLOB, precise REAL, Unicode, a quote, NUL and LF. The second restored 44 rows including a large JSON/BLOB record, crossed several import chunks and checked an empty table. Cloudflare's SQL export rounded test integers above the JavaScript safe-integer limit; the direct D1 verification preserved and matched those exact values. This is why exported SQL alone cannot establish parity for usage counters.

For the 24 November restore, 14,877,238 business rows map to the D1 schema before identities and generated tables. Budget about 56–70 million D1 writes for these business rows, depending on whether partial indexes match. With the full 50 million monthly included writes available, that portion is approximately $6–20 of overage. With the allowance already exhausted, it is approximately $56–70. These estimates exclude temporary-part writes, other activity and storage. A complete count and data-range scan is roughly 30–45 million billed reads. Such reads fit within the 25 billion monthly allowance if available, or cost about $0.03–0.05 when fully over quota. Use the actual per-invocation meters for reconciliation.

The script handles the current TokenTracker relational schema. New generated columns, virtual tables, cycles between distinct tables and multiple self-foreign-keys require separate handling. The destination's per-database and per-row limits still apply. It is an initial snapshot transfer; the cutoff and final new-write reconciliation must use the cutover plan. [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
