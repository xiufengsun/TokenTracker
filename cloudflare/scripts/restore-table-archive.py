"""Restore scoped business rows into an empty private local PostgreSQL and verify COPY counts."""

import argparse
import json
import hashlib
import os
from pathlib import Path
import re
import runpy
import subprocess
from tempfile import TemporaryDirectory

LOCAL_PG_HOST = runpy.run_path(str(Path(__file__).with_name("migration-platform.py")))["local_pg_host"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("archive", "passphrase-file", "socket", "receipt"):
        parser.add_argument("--" + option, type=Path, required=True)
    parser.add_argument("--port", required=True)
    args = parser.parse_args()
    if args.archive.suffix != ".gpg":
        parser.error("Use a sealed GPG archive")
    try:
        pg_host = LOCAL_PG_HOST(args.socket)
    except ValueError as error:
        parser.error(str(error))
    local = dict(
        os.environ, PGHOST=pg_host, PGPORT=args.port, PGDATABASE="postgres", PGCLIENTENCODING="UTF8"
    )
    local.pop("PGHOSTADDR", None)
    db = "tt_restore_" + os.urandom(6).hex()
    subprocess.run(["createdb", db], env=local, check=True)
    local["PGDATABASE"] = db
    decrypt_command = [
        "gpg",
        "--batch",
        "--no-symkey-cache",
        "--pinentry-mode",
        "loopback",
        "--passphrase-file",
        str(args.passphrase_file),
        "--decrypt",
        str(args.archive),
    ]

    def archive_metadata(options):
        # pg_restore may close its stdin after the TOC. The data pass below decrypts
        # to EOF and requires successful authentication of the entire archive.
        with subprocess.Popen(
            decrypt_command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        ) as stream:
            data = subprocess.check_output(
                ["pg_restore", *options], stdin=stream.stdout
            )
            stream.stdout.close()
            return data

    toc = archive_metadata(["--list"])
    entries = [
        line
        for line in toc.splitlines()
        if re.fullmatch(
            rb"\d+; \d+ \d+ (?:TABLE|SEQUENCE) public tokentracker_[a-z0-9_]+ \S+", line
        )
    ]
    if not entries:
        raise ValueError("Expected scoped table definitions in the archive")
    with TemporaryDirectory(prefix="tt-restore-selection-") as folder:
        selection = Path(folder) / "tables.txt"
        selection.write_bytes(b"\n".join(entries) + b"\n")
        ddl = archive_metadata(
            [
                "--use-list",
                str(selection),
                "--schema-only",
                "--no-owner",
                "--no-privileges",
                "-f",
                "-",
            ]
        )
    ddl = ddl.replace(b"SET transaction_timeout = 0;\n", b"")
    subprocess.run(
        ["psql", "-Xq", "-v", "ON_ERROR_STOP=1"], env=local, input=ddl, check=True
    )
    counts = {}
    sequences = {}
    # Keep the decrypted SQL inside pipes. Only the private encrypted volume holds rows.
    with (
        subprocess.Popen(
            [
                "gpg",
                "--batch",
                "--no-symkey-cache",
                "--pinentry-mode",
                "loopback",
                "--passphrase-file",
                str(args.passphrase_file),
                "--decrypt",
                str(args.archive),
            ],
            stdout=subprocess.PIPE,
        ) as decrypt,
        subprocess.Popen(
            ["pg_restore", "--data-only", "--no-owner", "--no-privileges", "-f", "-"],
            stdin=decrypt.stdout,
            stdout=subprocess.PIPE,
        ) as restore,
        subprocess.Popen(
            ["psql", "-Xq", "-v", "ON_ERROR_STOP=1"], env=local, stdin=subprocess.PIPE
        ) as load,
    ):
        decrypt.stdout.close()
        table = None
        for line in restore.stdout:
            if os.name == "nt" and line.endswith(b"\r\n"):
                line = line[:-2] + b"\n"
            if table:
                if line == b"\\.\n":
                    table = None
                else:
                    counts[table] += 1
            elif line.startswith(b"COPY "):
                m = re.match(rb"COPY public\.(tokentracker_[a-z0-9_]+) \(", line)
                if not m:
                    raise ValueError("Unexpected table outside TokenTracker archive")
                table = m[1].decode()
                counts[table] = 0
            elif line.startswith(b"SELECT pg_catalog.setval("):
                match = re.fullmatch(
                    rb"SELECT pg_catalog.setval\('public\.(tokentracker_[a-z0-9_]+)', (-?[0-9]+), (true|false)\);\n",
                    line,
                )
                if not match:
                    raise ValueError("Unexpected sequence outside TokenTracker archive")
                name = match[1].decode()
                sequences[name] = (int(match[2]), match[3] == b"true")
            elif line in (b"SET transaction_timeout = 0;\n",):
                # pg_dump 18 emits this setting; the production database is PostgreSQL 15.
                continue
            load.stdin.write(line)
        load.stdin.close()
        if load.wait() or restore.wait() or decrypt.wait() or table or not counts:
            raise RuntimeError("Restore pipeline incomplete")
    verification = " UNION ALL ".join(
        f"SELECT '{t}',count(*) FROM public.{t}" for t in counts
    )
    output = subprocess.check_output(
        ["psql", "-XAt", "-F", "|", "-c", verification], env=local, text=True
    )
    restored = {
        name: int(n) for name, n in (line.split("|") for line in output.splitlines())
    }
    if restored != counts:
        raise ValueError("Restored table counts do not match archive records")
    for name, expected in sequences.items():
        state = subprocess.check_output(
            ["psql", "-XAt", "-c", f"SELECT last_value,is_called FROM public.{name}"],
            env=local,
            text=True,
        ).strip()
        if state != f"{expected[0]}|{'t' if expected[1] else 'f'}":
            raise ValueError("Restored sequence differs from archive")
    with args.archive.open("rb") as archive_file:
        checksum = hashlib.file_digest(archive_file, "sha256").hexdigest()
    result = {
        "archive_sha256": checksum,
        "sequences": len(sequences),
        "database": db,
        "archive": args.archive.name,
        "tables": len(counts),
        "rows": sum(counts.values()),
        "table_counts": counts,
    }
    args.receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "table_counts"}))


if __name__ == "__main__":
    os.umask(0o077)
    main()
