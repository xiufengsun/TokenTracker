# TokenTracker source export cutoff

The exporter holds a PostgreSQL repeatable-read, read-only transaction open on the linked production project. It imports that transaction's exported snapshot into the account-column discovery query, the account projection query and the business-table dump. A concurrent insert or update after the cutoff is absent from both outputs. Reads of PostgreSQL sequence counters are nontransactional. Advance the corresponding target counters or recapture them after freezing writers if an imported table uses a sequence.

Run from the migration checkout with PostgreSQL client tools, GPG and the authenticated InsForge CLI. The linked project directory contains the existing local InsForge link. The script validates the production project and TLS hostname. Use an encrypted operator volume as scratch, a private JSON file with the target's AUTH_MIGRATION_KEY and a separate GPG passphrase file. A production target needs its own migration key.

```sh
python3 cloudflare/scripts/export-consistent-snapshot.py \
  --linked-project "$TT_LINKED_SOURCE" \
  --output "$TT_NEW_BACKUP_DIRECTORY" \
  --scratch "$TT_ENCRYPTED_SCRATCH" \
  --key-file "$TT_TARGET_SECRET_FILE" \
  --passphrase-file "$TT_GPG_PASSPHRASE_FILE"
```

A bounded rehearsal takes one or more exact table names with `--table tokentracker_community_stats`. Identity ownership still uses the full approved account scope. The default business dump matches public relations named `tokentracker_*`. AgentMeter rows are consulted only to exclude unrelated accounts. The identity projection carries approved password hashes for confirmed accounts, provider subjects and keyed identity matches. It omits provider credentials, refresh tokens, sessions and source admin keys.

Only a completed pair is published as the requested new directory. It contains `business.dump.gpg`, `identities.sqlite.gpg` and `receipt.json`. Read the encrypted files as a pair. Compare both SHA-256 digests with the receipt before restoring. The exporter authenticates both ciphertext streams, fully decodes the business archive and compares the recovered identity file bytes with the private SQLite projection. Use `restore-table-archive.py` for a PostgreSQL restore with row-count reconciliation. When constructing the D1 database, decrypt the matching identities into encrypted private scratch, verify its plaintext SHA-256 against the receipt and apply it to the same business restore.

The source stays writable during rehearsal. Before cutover, fence registrations, OAuth identity changes, token issuance, incoming uploads, payment callbacks and writers triggered by scheduled jobs. Drain pending writes and re-export the final source snapshot, or reconcile all commits since the receipt cutoff using an independently verified change stream. The snapshot's time and transaction range are audit references. Neither identifies later deletes for incremental replication.

The regression test creates and drops two disposable local databases. It commits an account insert, a new business row and an update via a second connection **after** snapshot export and **before** both readers start. It restores the GPG business archive and identity file, checks both contain the old rows, and checks the new source totals separately.

```sh
TT_TEST_PG_SOCKET="$TT_PRIVATE_LOCAL_PG_SOCKET" TT_TEST_PG_PORT="$TT_PRIVATE_LOCAL_PG_PORT" \
  python3 cloudflare/scripts/test/test_consistent_snapshot.py -v
```

## Rehearsal on 24 November 2026

The production read-only trial used one business table, tokentracker_community_stats, and the scoped identity projection. Snapshot `00000017-000032A7-1` began at 06:13:23.244646 UTC. The business archive restored into a separate local PostgreSQL database with one table and one row. The identity ciphertext decrypted into encrypted scratch, passed SQLite integrity and foreign-key checks and matched the receipt digest. It contained 3,404 confirmed accounts, 3,188 provider links and zero session, OAuth-flow, email-code or reset-token records. The projection classified 3,253 pending accounts and four ambiguous identity matches. Counts belong to this snapshot. The previously restored full-size business snapshot predates this paired projection.
