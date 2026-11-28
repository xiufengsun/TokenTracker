"""Import a sealed TokenTracker target SQLite image into a new, unbound D1 database.

Use the D1 import API to move bounded SQL files and independently verify data through SELECT.
Set CLOUDFLARE_API_TOKEN to a D1-edit credential. Pass the intended account, database UUID,
name and local input image. Verification does not write private row data to disk.
Re-run the same invocation after interruption, keeping the source file fixed.
"""

import argparse
from contextlib import closing
import hashlib
import http.client
import gzip
from concurrent.futures import ThreadPoolExecutor
from collections import deque
import datetime as dt
from threading import local, Lock
import socket
import subprocess
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "1"
MARKER = "tt_migration_import_parts"
SYSTEM = "name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'"
MAX_SQL = 95_000  # D1 limits each SQL statement to 100 KB.
ROW_LIMIT = 500  # Bound SQL value count and statement latency.


def ident(name):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError("Unsupported SQL identifier")
    return '"' + name + '"'


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)  # Never transit a Worker or JavaScript number.
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite SQLite value")
        return repr(value)
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    if any(c in value for c in "\x00\n\r"):
        return "CAST(X'" + value.encode().hex() + "' AS TEXT)"
    return "'" + value.replace("'", "''") + "'"


def columns(db, table):
    info = list(db.execute("PRAGMA table_xinfo(" + ident(table) + ")"))
    if not info or any(row[6] for row in info):
        raise ValueError(f"{table} has generated or hidden columns")
    pk = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
    fields = [row[1] for row in info]
    if not pk:
        # The quarantine history table permits identical rows and has no declared PK.
        # Preserve its implicit SQLite rowid as well, for deterministic chunking and verification.
        for alias in ("_rowid_", "rowid", "oid"):
            if alias not in {name.lower() for name in fields}:
                return [alias, *fields], [alias]
        raise ValueError(f"{table} has no accessible rowid")
    return fields, pk


def schema(db):
    result = {}
    for kind, name, ddl in db.execute(
        f"SELECT type,name,sql FROM sqlite_schema WHERE {SYSTEM} AND sql IS NOT NULL ORDER BY name"
    ):
        if name in (MARKER, "tt_migration_large_cells"):
            raise ValueError("Source contains transfer metadata")
        if kind not in ("table", "index", "trigger", "view") or ddl.upper().startswith(
            "CREATE VIRTUAL TABLE"
        ):
            raise ValueError(f"Unsupported schema object {name}")
        result[name] = (kind, ddl)
    if not result:
        raise ValueError("Source is empty")
    return result


def ordered_tables(db, objects):
    tables = {name for name, (kind, _) in objects.items() if kind == "table"}
    deps = {
        name: {
            row[2]
            for row in db.execute("PRAGMA foreign_key_list(" + ident(name) + ")")
            if row[2] != name
        }
        for name in tables
    }
    ordered = []
    while len(ordered) < len(tables):
        ready = sorted(t for t in tables - set(ordered) if deps[t].issubset(ordered))
        if not ready:
            raise ValueError("Cross-table foreign-key cycle or missing parent")
        ordered.extend(ready)
    return ordered


def source_rows(db, table, names, pk):
    fields = ",".join(map(ident, names))
    key = ",".join(map(ident, pk))
    quoted = ident(table)
    fks = [
        r
        for r in db.execute("PRAGMA foreign_key_list(" + quoted + ")")
        if r[2] == table
    ]
    if not fks:
        return db.execute(f"SELECT {fields} FROM {quoted} ORDER BY {key}")
    if len({r[0] for r in fks}) != 1 or any(r[4] is None for r in fks):
        raise ValueError(f"Unsupported self-reference in {table}")
    # Merged machines can reference another machine in the same table. Send parent rows first.
    roots = " OR ".join(ident(r[3]) + " IS NULL" for r in fks)
    join = " AND ".join("child." + ident(r[3]) + "=p." + ident(r[4]) for r in fks)
    return db.execute(
        f"""WITH RECURSIVE family AS(
        SELECT *,0 AS import_depth FROM {quoted} WHERE {roots}
        UNION ALL SELECT child.*,p.import_depth+1 FROM {quoted} child JOIN family p ON {join})
        SELECT {fields} FROM family ORDER BY import_depth,{key}"""
    )


def oversized_statements(table, names, row):
    # D1's file endpoint caps individual statements. Reassemble large text/blob cells locally
    # in the D1 import transaction, then insert the final row once, with its CHECK/FK rules active.
    if (
        sum(
            (
                len(x.encode())
                if isinstance(x, str)
                else len(x)
                if isinstance(x, bytes)
                else 8
            )
            for x in row
        )
        > 2_000_000
    ):
        raise ValueError(f"{table} contains a row above the D1 row-size limit")
    tmp = "tt_migration_large_cells"
    yield f"CREATE TABLE {tmp}(slot INTEGER,pos INTEGER,v BLOB,PRIMARY KEY(slot,pos)) WITHOUT ROWID;"
    values = []
    for slot, value in enumerate(row):
        if isinstance(value, (str, bytes)):
            raw = value.encode() if isinstance(value, str) else value
            if len(raw) > 1024:
                for pos in range(0, len(raw), 32768):
                    part = raw[pos : pos + 32768]
                    yield f"INSERT INTO {tmp} VALUES({slot},{pos},X'{part.hex()}');"
                assembled = f"(SELECT unhex(group_concat(hex(v),'' ORDER BY pos)) FROM {tmp} WHERE slot={slot})"
                values.append(
                    "CAST(" + assembled + " AS TEXT)"
                    if isinstance(value, str)
                    else assembled
                )
                continue
        values.append(literal(value))
    yield (
        "INSERT INTO "
        + ident(table)
        + "("
        + ",".join(map(ident, names))
        + ") VALUES("
        + ",".join(values)
        + ");"
    )
    yield "DROP TABLE " + tmp + ";"


def row_statements(db, table):
    names, pk = columns(db, table)
    prefix = (
        "INSERT INTO " + ident(table) + "(" + ",".join(map(ident, names)) + ") VALUES "
    )
    size = len(prefix)
    values = []
    count = 0
    for row in source_rows(db, table, names, pk):
        value = "(" + ",".join(map(literal, row)) + ")"
        width = len(value.encode()) + 1
        if len(prefix) + width > MAX_SQL:
            if values:
                yield (prefix + ",".join(values) + ";").encode() + b"\n"
                values = []
                size = len(prefix)
            block = b"".join(
                (sql + "\n").encode() for sql in oversized_statements(table, names, row)
            )
            yield block
            count += 1
            continue
        if values and (size + width > MAX_SQL or len(values) >= ROW_LIMIT):
            yield (prefix + ",".join(values) + ";").encode() + b"\n"
            values = []
            size = len(prefix)
        values.append(value)
        size += width
        count += 1
    if values:
        yield (prefix + ",".join(values) + ";").encode() + b"\n"
    if count != db.execute("SELECT count(*) FROM " + ident(table)).fetchone()[0]:
        raise ValueError(f"Unresolved self-reference in {table}")


def final_ddl(objects):
    return b"".join(
        (ddl + ";\n").encode()
        for kind, ddl in objects.values()
        if kind in ("view", "trigger")
    )


def chunks(db, objects, cap):
    tables = ordered_tables(db, objects)
    ddl = [objects[t][1] + ";" for t in tables]
    ddl.extend(value + ";" for kind, value in objects.values() if kind == "index")
    yield "schema", "\n".join(ddl).encode() + b"\n"
    for table in tables:
        data = bytearray()
        for part in row_statements(db, table):
            if data and len(data) + len(part) > cap:
                yield table, bytes(data)
                data.clear()
            data.extend(part)
        if data:
            yield table, bytes(data)
    # No derived-data or reset trigger may run while historical records are inserted.
    yield "finish", final_ddl(objects)


class TransferError(Exception):
    pass


class TransientTransferError(TransferError):
    pass


class ImportBusy(TransientTransferError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class Remote:
    def __init__(self, account, database, token):
        self.root = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}"
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect)
        self.connections = local()
        self.meter = {
            "api_calls": 0,
            "read_rows": 0,
            "written_rows": 0,
            "sql_ms": 0,
            "upload_bytes": 0,
            "download_bytes": 0,
        }
        self.lock = Lock()

    def add_meta(self, meta):
        with self.lock:
            self.meter["read_rows"] += meta.get("rows_read", 0)
            self.meter["written_rows"] += meta.get("rows_written", 0)
            self.meter["sql_ms"] += meta.get("duration", 0)

    def request(self, url, method="GET", data=None, headers=None):
        if urllib.parse.urlsplit(url).scheme != "https":
            raise TransferError("Non-HTTPS service URL")
        req = urllib.request.Request(
            url, data=data, headers=headers or {}, method=method
        )
        try:
            return self.opener.open(req, timeout=180)
        except urllib.error.HTTPError as e:
            # D1 errors and presigned URLs can contain SQL, private data and credentials.
            try:
                codes = [
                    r.get("code")
                    for r in json.loads(e.read()).get("errors", [])
                    if isinstance(r, dict)
                ]
            except (ValueError, AttributeError):
                codes = []
            failure = (
                TransientTransferError
                if e.code in (429, 500, 502, 503, 504)
                else TransferError
            )
            raise failure(
                f"D1 transfer HTTP {e.code}; provider codes {codes}"
            ) from None
        except (OSError, urllib.error.URLError):
            raise TransientTransferError(
                "Connection to D1 interrupted; retry the same invocation"
            ) from None

    def api(self, path="", body=None):
        # One persistent HTTPS connection per verification thread. Object uploads use a
        # separate client and never receive the API credential.
        headers = {
            "Content-Type": "application/json",
            "Accept-Encoding": "gzip",
        }
        payload = None if body is None else json.dumps(body).encode()
        parts = urllib.parse.urlsplit(self.root + path)
        retryable = path in ("", "/query")
        for attempt in range(5 if retryable else 1):
            headers["Authorization"] = "Bearer " + self.token()
            conn = getattr(self.connections, "https", None)
            if conn is None:
                conn = self.connections.https = http.client.HTTPSConnection(
                    parts.hostname, timeout=180
                )
            try:
                conn.request(
                    "GET" if body is None else "POST",
                    parts.path,
                    body=payload,
                    headers=headers,
                )
                res = conn.getresponse()
                raw = res.read()
                with self.lock:
                    self.meter["api_calls"] += 1
                    self.meter["download_bytes"] += len(raw)
                if res.getheader("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                if res.status != 200:
                    if (
                        retryable
                        and attempt < 4
                        and res.status in (429, 500, 502, 503, 504)
                    ):
                        wait = res.getheader("Retry-After", "")
                        time.sleep(
                            min(300, max(1, int(wait)))
                            if wait.isdecimal()
                            else min(15, 2**attempt)
                        )
                        continue
                    try:
                        codes = [
                            e.get("code")
                            for e in json.loads(raw).get("errors", [])
                            if isinstance(e, dict)
                        ]
                    except (ValueError, AttributeError):
                        codes = []
                    failure = (
                        TransientTransferError
                        if res.status in (429, 500, 502, 503, 504)
                        else TransferError
                    )
                    raise failure(f"D1 API HTTP {res.status}; provider codes {codes}")
                obj = json.loads(raw)
                break
            except (http.client.HTTPException, OSError, socket.timeout):
                conn.close()
                self.connections.https = None
                if retryable and attempt < 4:
                    continue
                raise TransientTransferError(
                    "Connection interrupted; retry the same invocation"
                ) from None
        if not obj.get("success"):
            raise TransferError("D1 API rejected request")
        return obj["result"]

    def query(self, sql, params=None):
        results = self.api("/query", {"sql": sql, "params": params or []})
        if len(results) != 1 or not results[0].get("success"):
            raise TransferError("D1 query failed")
        self.add_meta(results[0].get("meta", {}))
        return results[0]["results"]

    def upload(self, data):
        etag = hashlib.md5(data, usedforsecurity=False).hexdigest()
        state = self.api("/import", {"action": "init", "etag": etag})
        if "upload_url" in state:
            with self.lock:
                self.meter["upload_bytes"] += len(data)
            with self.request(
                state["upload_url"], "PUT", data, {"Content-Length": str(len(data))}
            ) as res:
                if res.status != 200 or res.headers.get("ETag", "").strip('"') != etag:
                    raise TransferError("D1 upload content checksum mismatch")
            state = self.api(
                "/import",
                {"action": "ingest", "filename": state["filename"], "etag": etag},
            )
        while state.get("status") != "complete":
            if (
                not state.get("success")
                or state.get("status") == "error"
                or not state.get("at_bookmark")
            ):
                details = json.dumps(state).lower()
                if "currently processing a long-running import" in details:
                    raise ImportBusy("D1 is still completing an import")
                patterns = [
                    "unique constraint",
                    "foreign key constraint",
                    "check constraint",
                    "not null constraint",
                    "out of memory",
                    "timed out",
                    "timeout",
                    "syntax error",
                    "incomplete input",
                    "too many",
                    "sql logic error",
                    "parser",
                    "overloaded",
                    "database or disk is full",
                    "exceeds",
                    "locked",
                    "already exists",
                    "internal",
                    "near maximum",
                    "too long",
                    "limit",
                ]
                categories = [label for label in patterns if label in details]
                codes = set(re.findall(r"SQLITE_[A-Z_]+", json.dumps(state)))
                status = state.get("status")
                safe_status = (
                    status
                    if status
                    in {
                        "error",
                        "active",
                        "ready",
                        "processing",
                        "pending",
                        "complete",
                        "uploading",
                    }
                    else "other"
                )
                raise TransferError(
                    "D1 import failed to commit: status="
                    + safe_status
                    + "; fields="
                    + ",".join(sorted(state))
                    + "; provider reason="
                    + ",".join(sorted(codes) + categories)
                )
            time.sleep(1)
            state = self.api(
                "/import", {"action": "poll", "current_bookmark": state["at_bookmark"]}
            )
        if not state.get("success"):
            raise TransferError("D1 import did not succeed")
        self.add_meta(state.get("result", {}).get("meta", {}))


def digest_row(digest, row):
    for value in row:
        if value is None:
            kind, raw = b"n", b""
        elif isinstance(value, int):
            kind, raw = b"i", struct.pack(">q", value)
        elif isinstance(value, float):
            kind, raw = b"r", struct.pack(">d", value)
        elif isinstance(value, bytes):
            kind, raw = b"b", value
        else:
            kind, raw = b"t", value.encode()
        digest.update(kind + struct.pack(">I", len(raw)) + raw)


def wire_column(col):
    # D1 JSON numbers and export SQL can round 64-bit integers. Convert inside SQLite first.
    q = ident(col)
    return (
        f"CASE typeof({q}) WHEN 'integer' THEN 'i'||CAST({q} AS TEXT) "
        f"WHEN 'real' THEN 'r'||printf('%!.26g',{q}) WHEN 'blob' THEN 'b'||hex({q}) "
        f"WHEN 'text' THEN 't'||{q} ELSE 'n' END"
    )


def decode(cell):
    kind, value = cell[0], cell[1:]
    if kind == "i":
        return int(value)
    if kind == "r":
        return float(value)
    if kind == "b":
        return bytes.fromhex(value)
    if kind == "t":
        return value
    if cell == "n":
        return None
    raise TransferError("Unexpected D1 read-back encoding")


def verify(src, remote, objects, page_rows, threads):
    with ThreadPoolExecutor(max_workers=threads) as pool:
        return verify_pages(src, remote, objects, page_rows, pool, threads)


def verify_pages(src, remote, objects, page_rows, pool, threads):
    records = {
        r["name"]: (r["type"], r["sql"])
        for r in remote.query(
            f"SELECT type,name,sql FROM sqlite_schema WHERE {SYSTEM} AND sql IS NOT NULL AND name<>?",
            [MARKER],
        )
    }
    if records != objects:
        raise TransferError("Remote schema objects or definitions differ from input")
    total = 0
    pages = 0
    for table in ordered_tables(src, objects):
        names, pk = columns(src, table)
        q = ident(table)
        key = ",".join(map(ident, pk))
        pk_offsets = [names.index(col) for col in pk]
        total_remote = int(
            remote.query(f"SELECT CAST(count(*) AS TEXT) AS n FROM {q}")[0]["n"]
        )
        total_src = src.execute(f"SELECT count(*) FROM {q}").fetchone()[0]
        if total_remote != total_src:
            raise TransferError(f"Remote row count differs in {table}")
        local_digest, remote_digest = hashlib.sha256(), hashlib.sha256()
        fields = ",".join(map(wire_column, names))
        cursor = src.execute(
            "SELECT " + ",".join(map(ident, names)) + f" FROM {q} ORDER BY " + key
        )

        def key_sql(row):
            return "(" + ",".join(literal(row[i]) for i in pk_offsets) + ")"

        # Bound the response for large private JSON documents independently from row count.
        def read_page(batch):
            where = (
                f"({key}) >= {key_sql(batch[0])} AND ({key}) <= {key_sql(batch[-1])}"
            )
            rows = remote.query(
                f"SELECT json_array({fields}) AS r FROM {q} WHERE {where} ORDER BY {key} LIMIT {len(batch) + 1}"
            )
            if len(rows) != len(batch):
                raise TransferError(f"Verification page length differs in {table}")
            return rows

        def verify_page(batch, rows):
            nonlocal pages
            for source, row in zip(batch, rows, strict=True):
                digest_row(local_digest, source)
                digest_row(remote_digest, tuple(map(decode, json.loads(row["r"]))))
            if local_digest.digest() != remote_digest.digest():
                raise TransferError(f"Full typed data differs in {table}")
            pages += 1

        def bounded_pages(batch):
            # Limit each response and concurrent memory. Longer individual rows get their own page.
            if (
                len(batch) > 1
                and sum(
                    sum(
                        (
                            len(v.encode())
                            if isinstance(v, str)
                            else 2 * len(v)
                            if isinstance(v, bytes)
                            else 24
                        )
                        for v in row
                    )
                    for row in batch
                )
                > 4_000_000
            ):
                mid = len(batch) // 2
                yield from bounded_pages(batch[:mid])
                yield from bounded_pages(batch[mid:])
            else:
                yield batch

        queue = deque()
        while fetched := cursor.fetchmany(page_rows):
            for batch in bounded_pages(fetched):
                queue.append((batch, pool.submit(read_page, batch)))
                if len(queue) >= threads:
                    prior, future = queue.popleft()
                    verify_page(prior, future.result())
        while queue:
            prior, future = queue.popleft()
            verify_page(prior, future.result())
        total += total_src
        print(
            json.dumps(
                {
                    "verified_table": table,
                    "rows": total_src,
                    "sha256": remote_digest.hexdigest(),
                    "meter_this_run": dict(remote.meter),
                }
            ),
            flush=True,
        )
    print(
        json.dumps(
            {
                "verified_rows": total,
                "verified_schema_objects": len(objects),
                "readback_pages": pages,
            }
        ),
        flush=True,
    )


def cloudflare_token_provider(oauth_file):
    import runpy

    require_private_file = runpy.run_path(str(Path(__file__).with_name("migration-platform.py")))["require_private_file"]
    lock = Lock()
    cached = {}

    def get_token():
        if oauth_file is None:
            token = os.environ.get("CLOUDFLARE_API_TOKEN")
            if not token:
                raise ValueError("Set CLOUDFLARE_API_TOKEN or pass --cf-oauth-file")
            return token
        # Only the caller-specified OAuth profile is read. The cf CLI owns refresh.
        with lock:
            if time.time() < cached.get("until", 0):
                return cached["token"]
            profile = oauth_file.resolve(strict=True)
            require_private_file(profile)
            creds = json.loads(profile.read_text())
            expiry = dt.datetime.fromisoformat(creds["expiration_time"]).timestamp()
            if expiry < time.time() + 10:
                cli = (
                    Path(__file__).resolve().parents[1] / "worker/node_modules/.bin"
                    / ("cf.cmd" if os.name == "nt" else "cf")
                )
                # The CLI renews only after expiry and may exit successfully
                # even when the HTTPS refresh was interrupted.
                time.sleep(max(0, expiry - time.time() + 0.5))
                for delay in (0, 2, 5, 10):
                    time.sleep(delay)
                    try:
                        subprocess.run(
                            [str(cli), "auth", "whoami"],
                            capture_output=True,
                            timeout=25,
                        )
                    except subprocess.TimeoutExpired:
                        pass
                    creds = json.loads(profile.read_text())
                    expiry = dt.datetime.fromisoformat(creds["expiration_time"]).timestamp()
                    if expiry > time.time() + 10:
                        break
                else:
                    raise TransferError(
                        "Cloudflare CLI session expired; sign in and resume"
                    )
            cached.update(
                token=creds["oauth_token"], until=min(time.time() + 30, expiry - 10)
            )
            return cached["token"]

    return get_token


def transfer(args):
    path = args.source.resolve(strict=True)
    if not 1 <= args.page_rows <= 10000:
        raise ValueError("Use 1 to 10000 rows per verification page")
    if args.chunk_mib < 1 or args.chunk_mib > 128:
        raise ValueError("Use a chunk cap between 1 and 128 MiB")
    if not re.fullmatch("[0-9a-f]{32}", args.account):
        raise ValueError("Invalid account ID")
    if not 1 <= args.readers <= 8:
        raise ValueError("Use 1–8 concurrent readers")
    remote = Remote(
        args.account, str(args.database), cloudflare_token_provider(args.cf_oauth_file)
    )
    info = remote.api()
    if info.get("name") != args.expect_name or info.get("uuid") != str(args.database):
        raise ValueError("Target identity mismatch")
    if args.receipt:
        receipt = json.loads(args.receipt.read_text())
        required = {"failed", "tables", "foreign_key_errors", "integrity", "bytes"}
        if (
            not required.issubset(receipt)
            or receipt["failed"]
            or receipt["foreign_key_errors"]
            or receipt["integrity"] != "ok"
            or receipt["bytes"] != path.stat().st_size
        ):
            raise ValueError(
                "Source recovery receipt is incomplete or does not match the file size"
            )
    elif not args.fixture:
        raise ValueError(
            "Supply the source '--receipt' produced by rehearse-d1-volume.py"
        )
    elif not re.search(r"(?:^|[-_])(qa|fixture)(?:$|[-_])", args.expect_name):
        raise ValueError("Synthetic --fixture runs require a QA target name")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        objects = schema(db)
        for table in ordered_tables(db, objects):
            columns(db, table)
        if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-journal")):
            raise ValueError("Use a closed, checkpointed SQLite snapshot")
        stat = path.stat()
        with path.open("rb") as f:
            source_hash = hashlib.file_digest(f, "sha256").hexdigest()

        def unchanged():
            now = path.stat()
            if (stat.st_ino, stat.st_size, stat.st_mtime_ns) != (
                now.st_ino,
                now.st_size,
                now.st_mtime_ns,
            ):
                raise ValueError("Source file changed during migration")

        unchanged()
        if args.receipt:
            for name, record in receipt["tables"].items():
                if (
                    db.execute("SELECT COUNT(*) FROM " + ident(name)).fetchone()[0]
                    != record["rows"]
                ):
                    raise ValueError(
                        f"Source row count differs from restore receipt for {name}"
                    )
            if receipt.get("sha256") and receipt["sha256"] != source_hash:
                raise ValueError("Source SHA-256 differs from restore receipt")
        if (
            db.execute("PRAGMA quick_check").fetchone() != ("ok",)
            or db.execute("PRAGMA foreign_key_check").fetchone()
        ):
            raise ValueError("Source integrity check failed")
        names = remote.query(
            f"SELECT name FROM sqlite_schema WHERE {SYSTEM} AND sql IS NOT NULL"
        )
        initialized = MARKER in {r["name"] for r in names}
        if not initialized:
            if names or args.verify_only:
                raise ValueError(
                    "New imports require an empty destination; use the original target to resume"
                )
            # The metadata and bootstrap row are created together in D1's atomic import.
            create = f"CREATE TABLE {MARKER}(part INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, snapshot TEXT NOT NULL) STRICT;"
            remote.upload(
                (
                    create
                    + f"\nINSERT INTO {MARKER} VALUES(0,'v{VERSION}-{args.chunk_mib}','{source_hash}');\n"
                ).encode()
            )
        parts = {
            r["part"]: r
            for r in remote.query(
                f"SELECT part,sha256,snapshot FROM {MARKER} ORDER BY part"
            )
        }
        if (
            not parts
            or list(parts) != list(range(len(parts)))
            or parts[0]["sha256"] != f"v{VERSION}-{args.chunk_mib}"
            or any(r["snapshot"] != source_hash for r in parts.values())
        ):
            raise ValueError(
                "Destination does not contain a contiguous transfer for this source and chunk size"
            )
        # A completed transfer can go straight through the independent verify pass. Even
        # if a checkpoint were invalid, missing or modified rows cannot pass typed readback.
        sealed = (
            max(parts) > 1
            and parts[max(parts)]["sha256"]
            == hashlib.sha256(final_ddl(objects)).hexdigest()
        )
        if args.verify_only and not sealed:
            raise ValueError("Import incomplete")
        if not sealed:
            completed = 0
            for part, (label, body) in enumerate(
                chunks(db, objects, args.chunk_mib * 1024 * 1024), 1
            ):
                hexdigest = hashlib.sha256(body).hexdigest()
                if part in parts:
                    if parts[part]["sha256"] != hexdigest:
                        raise ValueError(f"Source chunk {part} differs from checkpoint")
                elif args.verify_only:
                    raise ValueError("Import incomplete")
                else:
                    marker = f"INSERT INTO {MARKER} VALUES({part},'{hexdigest}','{source_hash}');\n".encode()
                    for attempt in range(12):
                        try:
                            remote.upload(body + marker)
                            break
                        except TransientTransferError:
                            # A lost acknowledgement may leave a committed batch.
                            # The checkpoint is written in the same D1 transaction.
                            time.sleep(min(30, 2 + attempt * 3))
                            try:
                                committed = remote.query(
                                    f"SELECT sha256,snapshot FROM {MARKER} WHERE part=?",
                                    [part],
                                )
                            except TransientTransferError:
                                continue
                            if committed:
                                if committed[0] != {
                                    "sha256": hexdigest,
                                    "snapshot": source_hash,
                                }:
                                    raise TransferError(
                                        "An existing checkpoint belongs to another batch"
                                    )
                                break
                    else:
                        raise TransferError(
                            "D1 stayed busy; resume from the last checkpoint"
                        )
                    print(
                        json.dumps(
                            {
                                "committed_part": part,
                                "stage": label,
                                "bytes": len(body),
                                "meter_this_run": dict(remote.meter),
                            }
                        ),
                        flush=True,
                    )
                    if args.stop_after == part:
                        return
                completed = part
            if max(parts) > completed:
                raise ValueError("Unexpected checkpoints past end of input")
        unchanged()
        import_meter = dict(remote.meter)
        print(json.dumps({"import_meter_this_run": import_meter}), flush=True)
        verify(db, remote, objects, args.page_rows, args.readers)
        unchanged()
        print(
            json.dumps(
                {
                    "verification_meter_this_run": {
                        k: v - import_meter[k] for k, v in remote.meter.items()
                    }
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    proof = parser.add_mutually_exclusive_group(required=True)
    proof.add_argument(
        "--receipt", type=Path, help="Completed source restore/rehearsal receipt"
    )
    proof.add_argument("--fixture", action="store_true", help="Synthetic QA input only")
    parser.add_argument("--account", required=True)
    parser.add_argument("--database", type=uuid.UUID, required=True)
    parser.add_argument("--expect-name", required=True)
    parser.add_argument("--page-rows", type=int, default=10000)
    parser.add_argument("--readers", type=int, default=4)
    parser.add_argument(
        "--cf-oauth-file",
        type=Path,
        help="Explicit private OAuth profile from cf auth login --no-use-keyring",
    )
    parser.add_argument("--chunk-mib", type=int, default=12)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument(
        "--stop-after",
        type=int,
        help="Stop cleanly after committing this chunk (resume rehearsal)",
    )
    try:
        transfer(parser.parse_args())
    except (ValueError, sqlite3.Error, TransferError, OSError) as error:
        # Never print a raw API failure body, SQL payload, signed URL, row value or credential.
        if isinstance(error, (TransferError, ValueError)):
            print(str(error), file=sys.stderr)
        else:
            print(f"Transfer failed ({type(error).__name__})", file=sys.stderr)
        raise SystemExit(1) from None
