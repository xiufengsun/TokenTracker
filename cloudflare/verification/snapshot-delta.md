# Reconcile the final snapshot before cutover

The source and destination are two closed SQLite images produced by the TokenTracker restore, projection and seal tools. Each image must have its own matching receipt. Use the same migrations, projected business table list, deployment-specific identity HMAC key and account ownership policy for both snapshots. Freeze source and target writers before taking the final cut. This includes device uploads, account creation, OAuth claims, subscription events and scheduled jobs. Keep the old service fence and external payment-event reconciliation in place until the destination passes full readback.

The comparison joins by declared primary key and compares SQLite storage types and values for every carried column. It counts inserts, updates and deletes without relying on application timestamps. Changes to source-owned TokenTracker business rows, confirmed accounts, provider links, keyed identity claims, ambiguity markers and the sealed public snapshot can be applied. A table with only an implicit rowid has no stable business identity across two independent PostgreSQL exports. The tool flags changes in that table or in unsupported derived tables for a full replacement. Input snapshots must have empty session, OAuth-flow, OTP and exchange-token tables.

Print the changes without writing to either database:

```sh
python3 cloudflare/scripts/reconcile-snapshot-delta.py \
  --before "$TT_BASE_IMAGE" --before-receipt "$TT_BASE_RECEIPT" \
  --after "$TT_FINAL_IMAGE" --after-receipt "$TT_FINAL_RECEIPT"
```

Add `--local-copy "$TT_CANDIDATE_CLONE"` to apply the delta to an offline copy of the baseline. The tool checks the clone against the full starting image and takes an immediate transaction lock. It suspends application triggers, inserts parents first, updates rows, removes children before parents, restores the original triggers, checks foreign keys and compares all rows against the final image before committing. An independent change in the candidate stops the operation before the transaction can commit. Retrying an already-correct destination returns `already_verified`.

For a D1 candidate, supply its UUID and expected account and name. Use encrypted private scratch for the required offline clone:

```sh
python3 cloudflare/scripts/reconcile-snapshot-delta.py \
  --before "$TT_BASE_IMAGE" --before-receipt "$TT_BASE_RECEIPT" \
  --after "$TT_FINAL_IMAGE" --after-receipt "$TT_FINAL_RECEIPT" \
  --account "$TT_CF_ACCOUNT_ID" --database "$TT_CANDIDATE_D1_ID" \
  --expect-name "$TT_CANDIDATE_NAME" --scratch "$TT_ENCRYPTED_SCRATCH" \
  --cf-oauth-file "$TT_CF_OAUTH_FILE"
```

The destination must already contain a completed baseline from `import-verified-sqlite.py`. Keep it unbound and isolated from writes. The tool first rehearses the exact SQL against the local clone. It then independently verifies every field and schema definition in the remote baseline. One atomic D1 import applies all changes, temporarily suspends triggers and records the new image digest in checkpoint part -1. A final remote read verifies the complete destination against the final sealed image. On retry the matching checkpoint causes verification only. Use the same delta invocation to verify a post-delta candidate. The bulk transfer's regular verify-only command continues to verify fresh initial imports. No delta operation updates routing, checkout settings or a Worker binding.

The default one-file SQL budget is 32 MiB and the tool accepts up to 128 MiB. It reports when unique constraints cannot be satisfied in that order, an update is larger than D1's per-statement limit, a schema or stable-key boundary is crossed, or the change set is too large. In those cases, use the full importer against the final sealed image and a fresh unbound D1. Even an accepted delta can be too slow for a live freeze because remote readback scans the whole database twice. Measure the real window before approving cutover.

## Cutover after a period of parallel writes

For a candidate that has already received mirror events, add `--parallel-readback "$TT_D1_IMPORT_RECEIPT"` to the D1 command. Use the original full-readback receipt containing the D1 UUID, name and source SHA-256. The same receipt anchors later runs. `--before` always refers to the source image recorded in the candidate's latest cutover checkpoint. This mode works without a local clone of the D1 candidate.

Freeze application writers and finish the mirror backlog before reconciling. The tool scans both sealed source images, then reads the actual D1 rows for every changed source key. An already applied change produces no row write. A source update can merge with a change to a different field on D1. A conflicting change to the same field stops the operation and requires an explicit resolution. D1-only accounts, sessions and other independent records stay in place. A source delete that would cascade into an independently created D1 record rolls back the import. Conflicts can also require reconciling an account or recalculating a derived rollup before continuing.

The import checks that the changed keys still contain the values seen during preflight, applies the remaining mutations, and records the new source checkpoint in the same transaction. The tool reads back every affected key and compares exact storage types and values, including pre-existing target changes on those rows. The initial full readback supplies the baseline evidence for historical rows. Repeating the invocation verifies the checkpoint and changed keys with no writes. The separate payment and writer-fence checks in the cutover runbook still apply.

On 27 November 2026, the Windows rehearsal imported and verified a ten-row baseline in a separate Cloudflare D1. The candidate had an active session, a D1-only account, and a signed 64-bit value that was already mirrored. The first reconciliation preserved those records while applying the remaining source changes. The repeat returned `already_verified`. Windows transaction tests also checked same-field conflicts, concurrent edits and an attempted cascade into a D1-only child.

## Rehearsals on 24 November 2026

- The offline test used clones of a real sealed small image on encrypted storage. One confirmed-account field changed without a timestamp change, one identity mapping was added and another deleted. Reapplying the delta returned `already_verified`. Private rows stayed on the machine.
- An independent Cloudflare D1 named tokentracker-migration-delta-qa held synthetic data only. Eleven mutations across five tables covered a parent replaced by a new key, a child moving to its new parent before the old one was deleted, same-key count and money corrections, case-only text changes, BLOB and NULL values, a large signed integer, an account insert and deletion of an identity mapping. The complete remote final state had ten rows and ten schema objects. Repeating the invocation verified all ten rows and reported zero remote writes. The full-import verify-only regression against the previous wide QA fixture also passed for 44 rows and three schema objects.
- Local transactional tests cover independent target drift, failed-transaction rollback, seals with a mismatched digest, an updated table without a stable key, and triggers that continue working after commit. Run `python3 cloudflare/scripts/test/test_snapshot_delta.py -v`.

The paid-scale production delta still requires two comparable final source images and a controlled write-free window. The initial full transfer, this isolated replay and dry-run estimates alone cannot establish the final production cutoff.
