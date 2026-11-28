"""Record applied D1 versions and seed the source public snapshot in a verified, private SQLite image."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess


LOCAL_PG_HOST = runpy.run_path(str(Path(__file__).with_name("migration-platform.py")))["local_pg_host"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "receipt", "restore-receipt", "socket"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--port", required=True)
    args = parser.parse_args()
    pg_host = LOCAL_PG_HOST(args.socket)
    report = json.loads(args.receipt.read_text())
    restored = json.loads(args.restore_receipt.read_text())
    if (
        report.get("integrity") != "ok"
        or report["failed"]
        or report["foreign_key_errors"]
        or restored["database"] != report["restored_db"]
    ):
        raise ValueError(
            "Complete the matching scoped restore and target reconciliation first"
        )
    if "sha256" in report:
        with args.source.open("rb") as image:
            if hashlib.file_digest(image, "sha256").hexdigest() != report["sha256"]:
                raise ValueError("Sealed SQLite image has changed")
        return
    env = dict(
        os.environ,
        PGHOST=pg_host,
        PGCLIENTENCODING="UTF8",
        PGPORT=args.port,
        PGDATABASE=restored["database"],
        PGOPTIONS="-c default_transaction_read_only=on -c timezone=UTC",
    )
    env.pop("PGHOSTADDR", None)
    query = """SELECT json_build_object('top_models',top_models,'providers',provider_breakdown,'daily_growth',daily_growth,
       'token_mix',token_mix,'user_distribution',user_distribution,'platforms',platform_distribution,
       'total_tokens',total_tokens,'active_developers_total',active_developers_total,'active_developers_30d',active_developers_30d,
       'tokens_30d',tokens_30d,'token_growth_pct',token_growth_pct,'developer_growth_pct',developer_growth_pct,
       'period','total','from',from_day,'to',to_day,'generated_at',generated_at)
       FROM public.tokentracker_community_stats WHERE id='total'"""
    snapshot = json.loads(
        subprocess.check_output(
            ["psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-c", query], env=env
        )
    )
    if not snapshot.get("generated_at") or snapshot.get("period") != "total":
        raise ValueError("Missing initial community snapshot")
    db = sqlite3.connect(args.source)
    expected = sorted(
        (Path(__file__).resolve().parents[1] / "migrations").glob("*.sql")
    )

    def catalog(conn):
        return dict(
            conn.execute(
                "SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name <> 'd1_migrations'"
            )
        )

    pristine = sqlite3.connect(":memory:")
    for migration in expected:
        pristine.executescript(migration.read_text())
    if catalog(pristine) != catalog(db):
        raise ValueError("Actual schema differs from current migration files")
    pristine.close()
    existing = db.execute(
        "SELECT 1 FROM sqlite_schema WHERE name='d1_migrations'"
    ).fetchone()
    if not existing and args.source.stat().st_size != report["bytes"]:
        raise ValueError("Target changed since reconciliation")
    with db:
        # A full load already contains the equivalent schema. Record that baseline so future
        # cf migrations apply starts at the next version instead of replaying CREATE TABLE.
        db.execute(
            'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'
        )
        db.executemany(
            "INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)",
            [(p.name,) for p in expected],
        )
        db.execute(
            "INSERT INTO community_snapshot(id,generated_at,payload) VALUES('total',?,?) ON CONFLICT(id) DO NOTHING",
            (
                snapshot["generated_at"],
                json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
            ),
        )
    value = db.execute(
        "SELECT payload FROM community_snapshot WHERE id='total'"
    ).fetchone()
    if value is None or json.loads(value[0]) != snapshot:
        raise ValueError("Public snapshot differs from archive")
    if [r[0] for r in db.execute("SELECT name FROM d1_migrations ORDER BY id")] != [
        p.name for p in expected
    ]:
        raise ValueError("Incorrect D1 migration baseline")
    db.close()
    report["derived_snapshot_generated_at"] = snapshot["generated_at"]
    report["migration_baseline"] = [p.name for p in expected]
    report["bytes"] = args.source.stat().st_size
    with args.source.open("rb") as image:
        report["sha256"] = hashlib.file_digest(image, "sha256").hexdigest()
    tmp = args.receipt.with_suffix(".seal.tmp")
    tmp.write_text(json.dumps(report, indent=2) + "\n")
    os.replace(tmp, args.receipt)
    print(
        json.dumps(
            {
                "bytes": report["bytes"],
                "sha256": report["sha256"],
                "migrations": len(expected),
            }
        )
    )


if __name__ == "__main__":
    os.umask(0o077)
    main()
