"""Rebuild the target schema from a restored, private PostgreSQL snapshot and verify all carried fields."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess


LOCAL_PG_HOST = runpy.run_path(str(Path(__file__).with_name("migration-platform.py")))["local_pg_host"]


def quoted(name):
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", name):
        raise ValueError("Unexpected database identifier")
    return '"' + name + '"'


# Count plus a commutative sum of per-record BLAKE2b digests compares multisets without
# imposing a source table order. Text money and integers remain exact.
def fingerprint(rows):
    total = 0
    count = 0
    for row in rows:
        encoded = json.dumps(
            list(row), ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode()
        total = (
            total
            + int.from_bytes(hashlib.blake2b(encoded, digest_size=16).digest(), "big")
        ) % (1 << 128)
        count += 1
    return count, total


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("restore-receipt", "socket", "out", "receipt"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--port", required=True)
    parser.add_argument("--identities", type=Path)
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Retry failed tables in a completed private rehearsal",
    )
    args = parser.parse_args()
    os.umask(0o077)
    if args.out.exists() != args.retry_failed:
        parser.error("Use a new file on a private volume")
    try:
        pg_host = LOCAL_PG_HOST(args.socket)
    except ValueError as error:
        parser.error(str(error))
    restored = json.loads(args.restore_receipt.read_text())
    env = dict(
        os.environ,
        PGHOST=pg_host,
        PGCLIENTENCODING="UTF8",
        PGPORT=args.port,
        PGDATABASE=restored["database"],
        PGOPTIONS="-c default_transaction_read_only=on -c timezone=UTC",
    )

    env.pop("PGHOSTADDR", None)

    def psql(query):
        return [
            "psql",
            "-XqAt",
            "--set=ON_ERROR_STOP=1",
            "--set=FETCH_COUNT=2000",
            "-c",
            query,
        ]

    db = sqlite3.connect(args.out)
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("PRAGMA temp_store=FILE")
    db.execute("PRAGMA cache_size=-262144")
    migrations = Path(__file__).resolve().parents[1] / "migrations"
    if not args.retry_failed:
        for path in sorted(migrations.glob("*.sql")):
            db.executescript(path.read_text())
    else:
        previous = json.loads(args.receipt.read_text())
        if (
            "integrity" not in previous
            or previous.get("restored_db", restored["database"]) != restored["database"]
            or previous["bytes"] != args.out.stat().st_size
        ):
            parser.error(
                "Retry requires the matching, finished snapshot receipt and SQLite database"
            )
        for table, counters in previous["tables"].items():
            if counters["rows"] != restored["table_counts"].get(table):
                parser.error("Source snapshot differs from the previous rehearsal")
    # Initial backfill bypasses *derived refresh* events; restore trigger definitions before validation.
    triggers = list(
        db.execute("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")
    )
    for name, _ in triggers:
        db.execute("DROP TRIGGER " + quoted(name))
    indexes = list(
        db.execute(
            "SELECT name,sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL"
        )
    )
    for name, _ in indexes:
        db.execute("DROP INDEX " + quoted(name))
    if args.identities and not args.retry_failed:
        db.execute("ATTACH DATABASE ? AS identity_source", (str(args.identities),))
        for (name,) in db.execute(
            "SELECT name FROM identity_source.sqlite_schema WHERE type='table' AND name LIKE 'tt_auth_%'"
        ):
            db.execute(
                "INSERT INTO main."
                + quoted(name)
                + " SELECT * FROM identity_source."
                + quoted(name)
            )
        db.commit()
        db.execute("DETACH DATABASE identity_source")
    active_tables = {
        r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")
    }
    report = {
        "platform": "local SQLite mirror of D1 migrations",
        "tables": {},
        "archive_only": {},
        "source_only_columns": {},
        "failed": {},
    }
    if args.retry_failed:
        report = previous
    report["restored_db"] = restored["database"]

    def save():
        report["bytes"] = args.out.stat().st_size
        args.receipt.write_text(json.dumps(report, indent=2))

    src = json.loads(
        subprocess.check_output(
            psql("""SELECT json_agg(row_to_json(x)) FROM
       (SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema='public') x"""),
            env=env,
            encoding="utf-8",
        )
    )
    lookup = {}
    for r in src:
        lookup.setdefault(r["table_name"], {})[r["column_name"]] = r["udt_name"]
    for table, expected in sorted(
        restored["table_counts"].items(), key=lambda kv: kv[1]
    ):
        if args.retry_failed and table not in previous["failed"]:
            continue
        if table not in active_tables:
            report["archive_only"][table] = expected
            continue
        target = {
            r[1]: r[2].upper()
            for r in db.execute("PRAGMA table_info(" + quoted(table) + ")")
        }
        types = lookup[table]
        cols = [c for c in target if c in types]
        if dif := sorted(set(types) - set(cols)):
            report["source_only_columns"][table] = dif
        expressions = []
        for c in cols:
            expr = quoted(c)
            if types[c] == "timestamptz":
                expr = f"""to_char({expr} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')"""
            elif types[c] in ("_uuid", "_date"):
                expr = f"array_to_json({expr})::text"
            elif types[c] == "bool":
                expr = f"{expr}::int"
            elif target[c] == "TEXT":
                expr = f"{expr}::text"
            elif target[c] == "REAL":
                expr = f"{expr}::float8"
            expressions.append(expr)
        if table == "tokentracker_device_codes" and "cloud_environment" not in types:
            # Source sandbox device codes have a different physical table. This archive
            # includes only production tokentracker_* relations.
            cols.append("cloud_environment")
            expressions.append("'live'::text")
        names = ",".join(map(quoted, cols))
        insert = (
            f"INSERT INTO {quoted(table)}({names}) VALUES("
            + ",".join("?" for _ in cols)
            + ")"
        )
        total = count = 0
        primary = sorted(
            (column[5], column[1])
            for column in db.execute("PRAGMA table_info(" + quoted(table) + ")")
            if column[5] and column[1] in types
        )
        order = (
            " ORDER BY " + ",".join(quoted(c) for _, c in primary)
            if primary and expected > 100000
            else ""
        )
        proc = subprocess.Popen(
            psql(
                "SELECT json_build_array("
                + ",".join(expressions)
                + ") FROM "
                + quoted(table)
                + order
            ),
            env=env,
            stdout=subprocess.PIPE,
            encoding="utf-8",
        )
        try:
            with db:
                # The target is a newly created private rehearsal. Source catalog/config
                # rows take precedence over initial defaults installed by a migration.
                db.execute("DELETE FROM " + quoted(table))
                chunk = []

                def flush():
                    nonlocal total, count
                    db.executemany(insert, chunk)
                    n, h = fingerprint(chunk)
                    count += n
                    total = (total + h) % (1 << 128)
                    chunk.clear()

                for line in proc.stdout:
                    row = json.loads(line)
                    chunk.append(
                        [
                            float(v) if v is not None and target[c] == "REAL" else v
                            for c, v in zip(cols, row)
                        ]
                    )
                    if len(chunk) == 2000:
                        flush()
                if chunk:
                    flush()
                if proc.wait() or count != expected:
                    raise ValueError("Source COUNT differs from restored archive")
            verified = fingerprint(
                db.execute("SELECT " + names + " FROM " + quoted(table))
            )
            if verified != (count, total):
                raise ValueError("Source and target fingerprints differ")
            report["failed"].pop(table, None)
            report["tables"][table] = {
                "rows": count,
                "columns": len(cols),
                "digest": format(total, "032x"),
            }
        except (sqlite3.Error, ValueError) as exc:
            proc.terminate()
            proc.wait()
            report["failed"][table] = str(exc)[:200]
        finally:
            proc.stdout.close()
        save()
    for _, ddl in indexes:
        db.execute(ddl)
    for _, ddl in triggers:
        db.execute(ddl)
    db.commit()
    report["foreign_key_errors"] = {}
    for rel, _, _, _ in db.execute("PRAGMA foreign_key_check"):
        errors = report["foreign_key_errors"]
        errors[rel] = errors.get(rel, 0) + 1
    report["integrity"] = db.execute("PRAGMA integrity_check").fetchone()[0]
    db.close()
    save()
    print(
        json.dumps(
            {
                "checked_tables": len(report["tables"]),
                "checked_rows": sum(r["rows"] for r in report["tables"].values()),
                "bytes": report["bytes"],
                "failed": report["failed"],
                "foreign_key_errors": report["foreign_key_errors"],
                "integrity": report["integrity"],
            }
        )
    )
    if report["failed"] or report["foreign_key_errors"] or report["integrity"] != "ok":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
