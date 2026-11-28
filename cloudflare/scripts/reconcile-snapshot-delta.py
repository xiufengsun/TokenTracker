"""Diff sealed TokenTracker D1 images and rehearse or apply one atomic cutover delta."""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import sqlite3
import tempfile
import uuid

TRANSFER = runpy.run_path(str(Path(__file__).with_name("import-verified-sqlite.py")))
ident = TRANSFER["ident"]
literal = TRANSFER["literal"]
MARKER = TRANSFER["MARKER"]
IDENTITY = {
    "tt_auth_accounts",
    "tt_auth_providers",
    "tt_auth_legacy",
    "tt_auth_identity_conflicts",
}
TRANSIENT = {
    "tt_auth_sessions",
    "tt_auth_oauth",
    "tt_auth_exchange",
    "tt_auth_email_codes",
    "tt_auth_reset_tokens",
}
# These two tables are built from source metadata and its public community snapshot at seal time.
SEALED_METADATA = {"community_snapshot", "d1_migrations"}


class ReplacementRequired(ValueError):
    """A fresh, unbound database is required for this pair of snapshots."""


def open_image(path):
    return sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)


def file_state(path):
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def load_proof(path, receipt):
    for suffix in ("-wal", "-journal"):
        if Path(str(path) + suffix).exists():
            raise ValueError("Checkpoint and close each source image before sealing")
    proof = json.loads(receipt.read_text())
    if (
        proof.get("integrity") != "ok"
        or proof.get("foreign_key_errors") not in ({}, [])
        or proof.get("failed") != {}
        or not proof.get("migration_baseline")
        or not isinstance(proof.get("tables"), dict)
        or proof.get("bytes") != path.stat().st_size
        or not re.fullmatch(r"[0-9a-f]{64}", str(proof.get("sha256")))
    ):
        raise ValueError("A completed seal receipt is required for each image")
    with path.open("rb") as src:
        if hashlib.file_digest(src, "sha256").hexdigest() != proof["sha256"]:
            raise ValueError("Seal digest differs from input")
    with closing(open_image(path)) as db:
        baseline = [
            r[0] for r in db.execute("SELECT name FROM d1_migrations ORDER BY id")
        ]
        if baseline != proof["migration_baseline"]:
            raise ValueError("Migration versions differ from the seal receipt")
        for t, check in proof["tables"].items():
            if (
                db.execute("SELECT count(*) FROM " + ident(t)).fetchone()[0]
                != check["rows"]
            ):
                raise ValueError(f"Source table count differs in {t}")
    return proof


def equal_columns(cols, left="a", right="b"):
    # Explicit BINARY matters for a case-only correction to columns declared NOCASE.
    return " AND ".join(
        f"(typeof({left}.{ident(c)})=typeof({right}.{ident(c)}) AND {left}.{ident(c)} IS {right}.{ident(c)} COLLATE BINARY)"
        for c in cols
    )


def table_diff(table, fields, pk, a, b, *, only_exists=False, count_only=False):
    # Schema names are supplied only by these local callers. Each comparison uses indexed primary-key lookups.
    t = ident(table)
    match = equal_columns(pk)
    # Keep lookup indexable. The exact typed match above rejects collation/coercion differences.
    lookup = " AND ".join(f"a.{ident(k)}=b.{ident(k)}" for k in pk) + " AND " + match

    def select(alias):
        return "1" if only_exists else ",".join(f"{alias}.{ident(c)}" for c in fields)

    changed = equal_columns([f for f in fields if f not in pk]) or "1"
    sql = {
        "insert": f"SELECT {select('b')} FROM {b}.{t} b WHERE NOT EXISTS(SELECT 1 FROM {a}.{t} a WHERE {lookup})",
        "update": f"SELECT {select('b')} FROM {b}.{t} b JOIN {a}.{t} a ON {lookup} WHERE NOT ({changed})",
        "delete": f"SELECT {select('a')} FROM {a}.{t} a WHERE NOT EXISTS(SELECT 1 FROM {b}.{t} b WHERE {lookup})",
    }
    if count_only:
        return {op: "SELECT COUNT(*) FROM (" + q + ")" for op, q in sql.items()}
    return {
        op: q
        + (
            " LIMIT 1"
            if only_exists
            else " ORDER BY "
            + ",".join(("a." if op == "delete" else "b.") + ident(k) for k in pk)
        )
        for op, q in sql.items()
    }


def any_changes(db, table, fields, pk, a, b):
    return any(
        db.execute(stmt).fetchone() is not None
        for stmt in table_diff(table, fields, pk, a, b, only_exists=True).values()
    )


def tables_match(db, objects, src, dst):
    for name, (kind, _) in objects.items():
        if kind == "table":
            fields, pk = TRANSFER["columns"](db, name)
            if any_changes(db, name, fields, pk, src, dst):
                return False
    return True


def dml(table, op, fields, pk, row):
    names = ",".join(map(ident, fields))
    q = ident(table)
    values = dict(zip(fields, row, strict=True))
    if op == "insert":
        stmt = (
            f"INSERT INTO {q} ({names}) VALUES (" + ",".join(map(literal, row)) + ");"
        )
    else:
        key = " AND ".join(
            f"{ident(k)} IS {literal(values[k])} COLLATE BINARY" for k in pk
        )
        if op == "delete":
            stmt = f"DELETE FROM {q} WHERE {key};"
        else:
            updates = ",".join(
                f"{ident(c)}={literal(values[c])}" for c in fields if c not in pk
            )
            stmt = f"UPDATE {q} SET {updates} WHERE {key};"
    if len(stmt.encode()) >= TRANSFER["MAX_SQL"]:
        if op != "insert":
            raise ReplacementRequired(
                f"{table} has a changed record beyond the D1 single-statement limit"
            )
        return list(TRANSFER["oversized_statements"](table, fields, row))
    return [stmt]


def plan(before, after, old_proof, new_proof, max_bytes, *, count_only=False, on_change=None):
    if (
        old_proof["migration_baseline"] != new_proof["migration_baseline"]
        or old_proof["tables"].keys() != new_proof["tables"].keys()
    ):
        raise ReplacementRequired(
            "The two snapshots have different migration versions or source-table scope"
        )
    eligible = set(new_proof["tables"]) | IDENTITY | SEALED_METADATA
    if any(not t.startswith("tokentracker_") for t in new_proof["tables"]):
        raise ReplacementRequired("Unrecognized source relation in the receipt")
    with closing(open_image(before)) as conn, closing(open_image(after)) as final:
        conn.execute(
            "ATTACH DATABASE ? AS newer", (after.as_uri() + "?mode=ro&immutable=1",)
        )
        objects = TRANSFER["schema"](conn)
        if objects != TRANSFER["schema"](final):
            raise ReplacementRequired("The snapshots have different schema definitions")
        tables = TRANSFER["ordered_tables"](conn, objects)
        if not set(new_proof["tables"]).issubset(tables):
            raise ValueError("Seal receipt lists missing business tables")
        if any(t.startswith("agentmeter_") for t in tables):
            raise ReplacementRequired(
                "Source is not a scoped TokenTracker target image"
            )
        tally = {}
        sets = {op: {t: [] for t in tables} for op in ("insert", "update", "delete")}
        size = 0
        for t in tables:
            fields, keys = TRANSFER["columns"](conn, t)
            if t in TRANSIENT and (
                conn.execute("SELECT 1 FROM main." + ident(t) + " LIMIT 1").fetchone()
                or conn.execute(
                    "SELECT 1 FROM newer." + ident(t) + " LIMIT 1"
                ).fetchone()
            ):
                raise ReplacementRequired(
                    f"Source image carries active credentials in {t}"
                )
            stable = any(
                r[5] for r in conn.execute("PRAGMA main.table_info(" + ident(t) + ")")
            )
            if not stable or t not in eligible:
                if any_changes(conn, t, fields, keys, "main", "newer"):
                    reason = (
                        "no declared stable primary key"
                        if not stable
                        else "not a source-owned migration table"
                    )
                    if not count_only:
                        raise ReplacementRequired(f"{t} changed and has {reason}")
                    tally[t] = {"full_replacement_required": reason}
                continue
            if count_only:
                counts = {
                    op: conn.execute(query).fetchone()[0]
                    for op, query in table_diff(
                        t, fields, keys, "main", "newer", count_only=True
                    ).items()
                }
                if any(counts.values()):
                    tally[t] = counts
                continue
            counts = {"insert": 0, "update": 0, "delete": 0}
            for op, stmt in table_diff(t, fields, keys, "main", "newer").items():
                for row in conn.execute(stmt):
                    output = dml(t, op, fields, keys, row)
                    size += sum(len(s.encode()) + 1 for s in output)
                    if size > max_bytes:
                        raise ReplacementRequired(
                            "Delta exceeds the one-file atomic import budget"
                        )
                    if on_change is not None:
                        on_change(conn, t, op, fields, keys, row)
                    sets[op][t].extend(output)
                    counts[op] += 1
            if any(counts.values()):
                tally[t] = counts
        if count_only:
            return objects, [], tally
        ddl = [(n, sql) for n, (kind, sql) in objects.items() if kind == "trigger"]
        statements = ["PRAGMA defer_foreign_keys=ON;"]
        statements.extend("DROP TRIGGER " + ident(n) + ";" for n, _ in ddl)
        for op, order in (
            ("insert", tables),
            ("update", tables),
            ("delete", reversed(tables)),
        ):
            for table in order:
                statements.extend(sets[op][table])
        statements.extend(sql.rstrip(";") + ";" for _, sql in ddl)
        if sum(len(s.encode()) + 1 for s in statements) + 4096 > max_bytes:
            raise ReplacementRequired(
                "Delta and schema restoration exceed the one-file budget"
            )
        return objects, statements, tally


def attach_sources(db, before, after):
    db.execute(
        "ATTACH DATABASE ? AS older", (before.as_uri() + "?mode=ro&immutable=1",)
    )
    db.execute("ATTACH DATABASE ? AS newer", (after.as_uri() + "?mode=ro&immutable=1",))


def check_local(before, after, target, objects, statements):
    if target.samefile(before) or target.samefile(after):
        raise ValueError("Apply only to a separate copy of the baseline")
    with closing(
        sqlite3.connect(target.as_uri() + "?mode=rw", uri=True, isolation_level=None)
    ) as db:
        db.execute("PRAGMA foreign_keys=ON")
        if db.execute("PRAGMA journal_mode").fetchone()[0] in ("off", "memory"):
            db.execute("PRAGMA journal_mode=DELETE")
        attach_sources(db, before, after)
        db.execute("BEGIN IMMEDIATE")
        try:
            if TRANSFER["schema"](db) != objects:
                raise ValueError("Candidate schema differs from the sealed baseline")
            if tables_match(db, objects, "main", "newer"):
                db.execute("ROLLBACK")
                return "already_verified"
            if not tables_match(db, objects, "main", "older"):
                raise ValueError(
                    "Candidate has independent row changes; refusing to overwrite"
                )
            for statement in statements:
                db.execute(statement)
            if db.execute("PRAGMA main.foreign_key_check").fetchone() or db.execute(
                "PRAGMA main.integrity_check"
            ).fetchone() != ("ok",):
                raise ReplacementRequired(
                    "Constraint or integrity verification failed in rehearsal"
                )
            if TRANSFER["schema"](db) != objects or not tables_match(
                db, objects, "main", "newer"
            ):
                raise ReplacementRequired(
                    "Applying the delta did not reproduce the final snapshot"
                )
            db.execute("COMMIT")
            return "applied_and_verified"
        except sqlite3.Error as exc:
            db.rollback()
            raise ReplacementRequired(
                f"Local transaction rejected the delta ({exc.sqlite_errorname}); use a fresh destination"
            ) from None
        except BaseException:
            db.rollback()
            raise


def apply_remote(
    args, before, after, objects, statements, old_hash, new_hash, ensure_unchanged
):
    remote = TRANSFER["Remote"](
        args.account,
        str(args.database),
        TRANSFER["cloudflare_token_provider"](args.cf_oauth_file),
    )
    info = remote.api()
    if info.get("name") != args.expect_name or info.get("uuid") != str(args.database):
        raise ValueError("Target name or UUID mismatch")
    stamp = remote.query(
        f"SELECT part,snapshot FROM {MARKER} WHERE part IN (-1,0) ORDER BY part LIMIT 1"
    )
    if len(stamp) != 1:
        raise ValueError("Target is missing the initial import checkpoint")
    if stamp[0]["part"] == 0:
        latest = remote.query(
            f"SELECT part,sha256 FROM {MARKER} ORDER BY part DESC LIMIT 1"
        )
        if (
            not latest
            or latest[0]["part"] < 2
            or latest[0]["sha256"]
            != hashlib.sha256(TRANSFER["final_ddl"](objects)).hexdigest()
        ):
            raise ValueError("Initial bulk transfer is incomplete")
    current = stamp[0]["snapshot"]
    if current not in (old_hash, new_hash):
        raise ValueError("Remote checkpoint is for a different source image")
    if current == new_hash:
        with closing(open_image(after)) as final:
            TRANSFER["verify"](final, remote, objects, args.page_rows, args.readers)
        return "already_verified"
    with closing(open_image(before)) as initial:
        TRANSFER["verify"](initial, remote, objects, args.page_rows, args.readers)
    # The guard and final checkpoint are part of the same atomic D1 import as all table changes.
    # Only an immutable, completed import with application writers frozen may be updated.
    guard = "tt_migration_delta_guard"
    assert guard not in objects
    prologue = [
        f"CREATE TABLE {guard}(v INTEGER NOT NULL CHECK(v=1));",
        f"INSERT INTO {guard} SELECT (SELECT snapshot FROM {MARKER} WHERE part IN(-1,0) ORDER BY part LIMIT 1) IS {literal(old_hash)};",
        f"DROP TABLE {guard};",
    ]
    epilogue = f"INSERT INTO {MARKER}(part,sha256,snapshot) VALUES(-1,'delta-v1',{literal(new_hash)}) ON CONFLICT(part) DO UPDATE SET sha256=excluded.sha256,snapshot=excluded.snapshot;"
    ensure_unchanged()
    remote.upload(("\n".join([*prologue, *statements, epilogue]) + "\n").encode())
    result = remote.query(f"SELECT snapshot FROM {MARKER} WHERE part=-1")
    if result != [{"snapshot": new_hash}]:
        raise RuntimeError("Missing final delta checkpoint")
    with closing(open_image(after)) as final:
        TRANSFER["verify"](final, remote, objects, args.page_rows, args.readers)
    return "applied_and_verified"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for n in ("before", "after", "before-receipt", "after-receipt"):
        parser.add_argument("--" + n, type=Path, required=True)
    target = parser.add_mutually_exclusive_group()
    target.add_argument(
        "--local-copy",
        type=Path,
        help="Update a separate existing offline baseline clone",
    )
    target.add_argument(
        "--database", type=uuid.UUID, help="Explicit frozen, unbound D1 candidate UUID"
    )
    parser.add_argument("--account")
    parser.add_argument("--expect-name")
    parser.add_argument(
        "--scratch",
        type=Path,
        help="Private encrypted directory for local preflight before remote apply",
    )
    parser.add_argument("--cf-oauth-file", type=Path)
    parser.add_argument(
        "--parallel-readback", type=Path,
        help="Original verified D1 import receipt for a candidate that has accepted parallel writes",
    )
    parser.add_argument(
        "--page-rows",
        type=int,
        choices=range(1, 10001),
        metavar="1..10000",
        default=5000,
    )
    parser.add_argument("--readers", type=int, choices=range(1, 9), default=4)
    parser.add_argument(
        "--max-mib", type=int, choices=range(1, 129), metavar="1..128", default=32
    )
    args = parser.parse_args()
    if args.parallel_readback and not args.database:
        parser.error("Parallel reconciliation requires the frozen D1 candidate UUID")
    before, after = args.before.resolve(strict=True), args.after.resolve(strict=True)
    states = [file_state(path) for path in (before, after)]

    def ensure_unchanged():
        if states != [file_state(path) for path in (before, after)] or any(
            Path(str(path) + suffix).exists()
            for path in (before, after)
            for suffix in ("-wal", "-journal")
        ):
            raise ValueError("A sealed input changed during comparison")

    p, q = load_proof(before, args.before_receipt), load_proof(
        after, args.after_receipt
    )
    parallel = None
    if args.parallel_readback:
        parallel = runpy.run_path(str(Path(__file__).with_name("parallel-snapshot-delta.py")))["ParallelDelta"](
            TRANSFER, MARKER, args.max_mib * 1024 * 1024
        )
    objects, statements, tally = plan(
        before,
        after,
        p,
        q,
        args.max_mib * 1024 * 1024,
        count_only=not (args.database or args.local_copy),
        on_change=parallel.collect if parallel else None,
    )
    ensure_unchanged()
    if args.database:
        if (
            (not args.scratch and not parallel)
            or not args.expect_name
            or not re.fullmatch("[0-9a-f]{32}", args.account or "")
        ):
            parser.error(
                "Remote apply requires account and expected D1 name, plus private scratch for the baseline-only mode"
            )
        if parallel:
            with closing(open_image(before)) as original:
                state = parallel.apply(args, original, objects, p["sha256"], q["sha256"], ensure_unchanged)
        else:
            with tempfile.TemporaryDirectory(prefix="tt-delta-", dir=args.scratch) as folder:
                clone = Path(folder) / "candidate.sqlite"
                shutil.copyfile(before, clone)
                check_local(before, after, clone, objects, statements)
            state = apply_remote(
                args, before, after, objects, statements, p["sha256"], q["sha256"], ensure_unchanged,
            )
    elif args.local_copy:
        state = check_local(
            before, after, args.local_copy.resolve(strict=True), objects, statements
        )
    else:
        state = "diff_only"
    ensure_unchanged()
    print(
        json.dumps(
            {
                "before": p["sha256"],
                "after": q["sha256"],
                "changes": tally,
                "status": state,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except ReplacementRequired as exc:
        raise SystemExit("Full replacement required: " + str(exc))
