"""Copy a bounded TokenTracker usage sample into the staging database and verify every field."""

import argparse
from datetime import date
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from uuid import UUID

COLUMNS = (
    "user_id device_id source model hour_start input_tokens cached_input_tokens "
    "cache_creation_input_tokens output_tokens reasoning_output_tokens total_tokens "
    "billable_total_tokens conversations created_at updated_at total_cost_usd"
).split()
KEY = COLUMNS[:5]
TIMESTAMPS = {"hour_start", "created_at", "updated_at"}
TABLE = "tokentracker_hourly"
CF = ["npx", "--yes", "cf@1.0.0-rc.4"]


def run_json(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        # CLI error payloads can contain bound row values.
        raise RuntimeError(f"{command[0]} exited with status {result.returncode}")
    return json.loads(result.stdout)


def source_column(name):
    # Normalize timestamps before comparing text keys; keep integers and money lossless in JSON.
    if name in TIMESTAMPS:
        return f"""to_char({name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS {name}"""
    return f"{name}::text AS {name}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=UUID)
    parser.add_argument(
        "--day",
        type=date.fromisoformat,
        help="UTC day, sampling at most ten updated records in each hour",
    )
    args = parser.parse_args()
    db = str(args.database)
    target = run_json(CF + ["d1", "get", db])
    if target["name"] != "tokentracker-migration-staging":
        parser.error("This rehearsal requires the TokenTracker staging database")
    fields = ", ".join(map(source_column, COLUMNS))
    if args.day:
        # Lateral index seeks avoid sorting a day of large rows just to take 24 samples.
        sql = f"""SELECT {fields} FROM generate_series(
                     '{args.day}T00:00:00Z'::timestamptz,
                     '{args.day}T23:00:00Z'::timestamptz, interval '1 hour') AS bins(t)
                  CROSS JOIN LATERAL (
                    SELECT * FROM public.{TABLE} AS h WHERE h.updated_at >= bins.t
                    AND h.updated_at < bins.t + interval '1 hour' ORDER BY h.updated_at LIMIT 10
                  ) AS records"""
    else:
        sql = f"SELECT {fields} FROM public.{TABLE} AS h ORDER BY h.updated_at DESC LIMIT 100"
    source = run_json(["npx", "@insforge/cli", "db", "query", sql, "--json"])["rows"]
    if not source:
        raise ValueError("Empty source sample")
    with TemporaryDirectory(prefix="tt-d1-audit-") as directory:
        file = Path(directory, "batch.json")

        def query(batch):
            file.write_text(json.dumps(batch))
            result = run_json(CF + ["d1", "query", db, "--batch", "@" + str(file)])
            if len(result) != len(batch) or not all(r["success"] for r in result):
                raise ValueError("Incomplete D1 query batch")
            return result

        schema = (
            Path(__file__)
            .resolve()
            .parents[1]
            .joinpath("migrations/0002_hourly.sql")
            .read_text()
        )
        query(
            [{"sql": statement} for statement in schema.split(";") if statement.strip()]
        )
        values = ", ".join("?" for _ in COLUMNS)
        updates = ", ".join(f"{c} = excluded.{c}" for c in COLUMNS[len(KEY) :])
        insert = (
            f"INSERT INTO {TABLE} ({', '.join(COLUMNS)}) VALUES ({values}) "
            f"ON CONFLICT ({', '.join(KEY)}) DO UPDATE SET {updates} "
            f"WHERE excluded.updated_at > {TABLE}.updated_at"
        )
        select = (
            "SELECT "
            + ", ".join(f"CAST({c} AS TEXT) AS {c}" for c in COLUMNS)
            + f" FROM {TABLE} WHERE "
            + " AND ".join(f"{k}=?" for k in KEY)
        )
        written = 0
        replay = 0
        for offset in range(0, len(source), 25):
            chunk = source[offset : offset + 25]
            writes = [
                {"sql": insert, "params": [row[c] for c in COLUMNS]} for row in chunk
            ]
            written += sum(r["meta"]["rows_written"] for r in query(writes))
            replay += sum(r["meta"]["rows_written"] for r in query(writes))
            readback = query(
                [{"sql": select, "params": [row[k] for k in KEY]} for row in chunk]
            )
            if any(
                result["results"] != [row]
                for row, result in zip(chunk, readback, strict=True)
            ):
                raise ValueError("Source and D1 differ for at least one usage bucket")
        if replay:
            raise ValueError("Replaying identical records wrote new rows")
        print(
            json.dumps(
                {
                    "matched": len(source),
                    "fields": len(COLUMNS),
                    "rows_written": written,
                    "replay_rows_written": replay,
                }
            )
        )


if __name__ == "__main__":
    os.umask(0o077)
    main()
