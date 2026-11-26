"""Read-only, same-snapshot financial restore rehearsal. Source records stay in process memory."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from urllib.parse import unquote, urlsplit

TABLES = [
    "policy",
    "catalog",
    "accounts",
    "orders",
    "checkout_operations",
    "subscriptions",
    "payments",
    "events",
    "gift_attempts",
    "gift_batches",
    "gift_codes",
    "gift_grants",
    "waffo_attempts",
    "waffo_periods",
    "waffo_authorizations",
]
PREFIX = "tokentracker_cloud_"
ROOT = Path(__file__).resolve().parents[3]


def source_data(project_dir):
    uri = urlsplit(
        json.loads(
            subprocess.check_output(
                ["npx", "@insforge/cli", "db", "connection-string", "--json"],
                cwd=project_dir,
                text=True,
            )
        )["connectionURL"]
    )
    env = dict(
        os.environ,
        PGHOST=uri.hostname,
        PGPORT=str(uri.port or 5432),
        PGUSER=unquote(uri.username),
        PGDATABASE=unquote(uri.path[1:]),
        PGPASSWORD=unquote(uri.password),
        PGSSLROOTCERT="system",
        PGSSLMODE="verify-full",
        PGCONNECT_TIMEOUT="8",
        PGAPPNAME="TokenTracker billing parity",
        PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60000",
    )
    owners = " UNION ".join(
        "SELECT user_id,environment FROM " + PREFIX + n
        for n in ["accounts", "orders", "payments", "gift_grants", "subscriptions"]
    )
    # One SQL statement pins rows, the reference clock and calculated memberships to the same snapshot.
    sections = [
        f"'{name}',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.{PREFIX}{name} t)"
        for name in TABLES
    ]
    sections.extend(
        [
            "'devices',(SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]') FROM (SELECT user_id,min(created_at) AS created_at "
            "FROM public.tokentracker_devices WHERE user_id IN (SELECT user_id FROM owners) GROUP BY user_id) d)",
            "'expected',(SELECT coalesce(jsonb_agg(jsonb_build_object('uid',user_id,'scope',environment,"
            "'state',public.cloud_membership(user_id,environment))),'[]') FROM owners)",
            "'measured_at',statement_timestamp()",
        ]
    )
    query = (
        "WITH owners AS ("
        + owners
        + ") SELECT jsonb_build_object("
        + ",".join(sections)
        + ")"
    )
    out = subprocess.run(
        ["psql", "-XAt", "--no-password", "-v", "ON_ERROR_STOP=1", "-c", query],
        env=env,
        capture_output=True,
        text=True,
    )
    if out.returncode:
        raise RuntimeError(out.stderr.strip())
    return json.loads(out.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("linked_source")
    args = parser.parse_args()
    data = source_data(args.linked_source)
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    for name in [
        "0020_billing.sql",
        "0021_waffo.sql",
        "0022_waffo_unique_bindings.sql",
    ]:
        db.executescript((ROOT / "cloudflare/migrations" / name).read_text())
    db.execute("CREATE TABLE tokentracker_devices (user_id TEXT,created_at TEXT)")
    counts = {}
    for name in TABLES + ["devices"]:
        table = "tokentracker_devices" if name == "devices" else PREFIX + name
        fields = [row["name"] for row in db.execute(f"pragma table_info({table})")]
        raw = data[name]
        rows = [
            tuple(
                (
                    json.dumps(row[f], sort_keys=True)
                    if isinstance(row[f], (dict, list))
                    else row[f]
                )
                for f in fields
            )
            for row in raw
        ]
        db.executemany(
            f"INSERT INTO {table} ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})",
            rows,
        )
        if rows:
            # Recompare every table value from a separate read. Row order is not significant.
            def key(r):
                return json.dumps(r, ensure_ascii=False)

            actual = [
                tuple(row)
                for row in db.execute(f"SELECT {','.join(fields)} FROM {table}")
            ]
            expected = [
                tuple(int(v) if type(v) is bool else v for v in row) for row in rows
            ]
            if sorted(actual, key=key) != sorted(expected, key=key):
                raise ValueError("Restored field mismatch in " + name)
        counts[name] = len(rows)
    module = ROOT / "cloudflare/worker/src/billing-membership.ts"
    query = subprocess.check_output(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {membershipQuery} from "
            + json.dumps(module.as_uri())
            + ";process.stdout.write(membershipQuery('?','?'))",
        ],
        text=True,
    )
    # Run the deployed membership SELECT at the source's reference instant.
    instant = (
        dt.datetime.fromisoformat(data["measured_at"])
        .astimezone(dt.timezone.utc)
        .isoformat()
    )
    query = query.replace("'now'", "'" + instant + "'")
    misses = {}
    for user in data["expected"]:
        restored = dict(db.execute(query, (user["uid"], user["scope"])).fetchone())
        wanted = user["state"]
        for field in wanted.keys() | restored.keys():
            a, b = restored.get(field), wanted.get(field)
            if (
                isinstance(a, str)
                and isinstance(b, str)
                and field.endswith(("_at", "_until"))
            ):
                match = (
                    abs(
                        (
                            dt.datetime.fromisoformat(a) - dt.datetime.fromisoformat(b)
                        ).total_seconds()
                    )
                    < 0.00101
                )
            else:
                match = a == b
            if not match:
                misses[field] = misses.get(field, 0) + 1
    foreign_keys = len(db.execute("pragma foreign_key_check").fetchall())
    print(
        json.dumps(
            {
                "source_time": data["measured_at"],
                "verified_rows": counts,
                "membership_pairs": len(data["expected"]),
                "membership_differences": misses,
                "foreign_key_errors": foreign_keys,
            }
        )
    )
    if misses or foreign_keys:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
