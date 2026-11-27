"""Export TokenTracker business rows and scoped identities from one read-only PostgreSQL snapshot."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SCOPE = runpy.run_path(str(HERE / "audit-account-scope.py"))
PROJECT = runpy.run_path(str(HERE / "project-identities.py"))["project"]
PRIVATE_FILE = runpy.run_path(str(HERE / "migration-platform.py"))["require_private_file"]


@contextlib.contextmanager
def snapshot_lease(env):
    """Keep the exporting backend alive until every consumer has finished."""
    with subprocess.Popen(["psql", "-XqAt", "--no-password", "--set=ON_ERROR_STOP=1"],
                          env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8") as holder:
        try:
            holder.stdin.write("""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL idle_in_transaction_session_timeout = 0;
SET LOCAL tcp_keepalives_idle = 30;
SET LOCAL tcp_keepalives_interval = 10;
SELECT json_build_object('snapshot_id',pg_export_snapshot(),'visible_transactions',pg_current_snapshot()::text,
                         'source_time_utc',transaction_timestamp() AT TIME ZONE 'UTC',
                         'source_database',current_database(),'server_version',current_setting('server_version'));
""")
            holder.stdin.flush()
            line = holder.stdout.readline()
            if not line:
                raise RuntimeError("PostgreSQL did not provide a snapshot")
            snapshot = json.loads(line)
            if not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+", snapshot["snapshot_id"]):
                raise ValueError("Invalid source snapshot")
            yield snapshot
        finally:
            holder.stdin.close()  # EOF rolls back the exporting read-only transaction.
            if holder.wait():
                raise RuntimeError("PostgreSQL snapshot holder exited with an error")


def gpg_command(passphrase):
    return ["gpg", "--batch", "--no-symkey-cache", "--pinentry-mode", "loopback",
            "--passphrase-file", str(passphrase)]


def file_digest(path):
    with path.open("rb") as data:
        return hashlib.file_digest(data, "sha256").hexdigest()


def seal_business(folder, env, snapshot, passphrase, tables):
    dump = ["pg_dump", "--no-password", "--format=custom", "--compress=3", "--lock-wait-timeout=5s",
            "--snapshot", snapshot["snapshot_id"], "--strict-names"]
    for table in tables:
        dump += ["--table", "public." + table]
    output = folder / "business.dump.gpg"
    with subprocess.Popen(dump, stdout=subprocess.PIPE, env=env) as source:
        try:
            subprocess.run(gpg_command(passphrase) + ["--symmetric", "--cipher-algo", "AES256",
                           "--compress-algo", "none", "--output", str(output)], stdin=source.stdout, check=True)
        finally:
            source.stdout.close()
            if source.wait():
                raise RuntimeError("Scoped pg_dump failed")
    return output


def verify_business(output, passphrase):
    # Consume the authenticated ciphertext AND every archived row, not just the TOC.
    with subprocess.Popen(gpg_command(passphrase) + ["--decrypt", str(output)], stdout=subprocess.PIPE) as decrypt:
        try:
            subprocess.run(["pg_restore", "--file", os.devnull], stdin=decrypt.stdout, check=True)
        finally:
            decrypt.stdout.close()
            if decrypt.wait():
                raise RuntimeError("Business archive decryption failed")


def export(output, scratch, key_file, passphrase, env, tables):
    output = output.resolve()
    if output.exists():
        raise FileExistsError("Choose a new output directory")
    if not output.parent.is_dir() or not scratch.is_dir():
        raise ValueError("Output parent and private encrypted scratch directory must exist")
    for table in tables:
        if table != "tokentracker_*" and not re.fullmatch(r"tokentracker_[a-z0-9_]+", table):
            raise ValueError("Only TokenTracker business tables are in scope")
    if not tables:
        raise ValueError("At least one business relation is required")
    PRIVATE_FILE(passphrase)
    PRIVATE_FILE(key_file)
    if passphrase.stat().st_size < 32:
        raise ValueError("A strong archive passphrase is required")
    # Do not inherit a 2-minute metadata query timeout for an entire COPY/pg_dump.
    dump_env = dict(env, PGOPTIONS="-c default_transaction_read_only=on -c timezone=UTC")
    with tempfile.TemporaryDirectory(prefix=".tt-snapshot-", dir=output.parent) as staging, \
         tempfile.TemporaryDirectory(prefix="tt-id-", dir=scratch) as private:
        folder = Path(staging)
        plain = Path(private) / "identities.sqlite"
        with snapshot_lease(env) as snapshot:
            # The projection's schema discovery and scoped auth query both import this snapshot.
            counts = PROJECT(plain, key_file, env, snapshot["snapshot_id"])
            business = seal_business(folder, dump_env, snapshot, passphrase, tables)
        verify_business(business, passphrase)
        identities = folder / "identities.sqlite.gpg"
        subprocess.run(gpg_command(passphrase) + ["--symmetric", "--cipher-algo", "AES256", "--output",
                       str(identities), str(plain)], check=True)
        with subprocess.Popen(gpg_command(passphrase) + ["--decrypt", str(identities)], stdout=subprocess.PIPE) as verify:
            decoded_hash = hashlib.file_digest(verify.stdout, "sha256").hexdigest()
            if verify.wait() or decoded_hash != file_digest(plain):
                raise ValueError("Identity ciphertext readback differs from its source")
        receipt = dict(snapshot, tables=tables, identity_counts=counts, identity_plain_sha256=decoded_hash,
                       encrypted_files={f.name: {"bytes": f.stat().st_size, "sha256": file_digest(f)}
                                        for f in (business, identities)})
        (folder / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        # Only a fully verified pair with a receipt becomes visible at the destination.
        os.rename(folder, output)
    return receipt


if __name__ == "__main__":
    os.umask(0o077)
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--linked-project", required=True, type=Path, help="Directory linked to the source InsForge project")
    cli.add_argument("--output", required=True, type=Path, help="New directory for the two sealed files and receipt")
    cli.add_argument("--scratch", required=True, type=Path, help="Private directory on an encrypted operator volume for temporary identity rows")
    cli.add_argument("--key-file", required=True, type=Path, help="Private JSON containing the target's AUTH_MIGRATION_KEY")
    cli.add_argument("--passphrase-file", required=True, type=Path, help="Existing private GPG passphrase file outside the output directory")
    cli.add_argument("--table", action="append", help="Exact tokentracker_ table for a limited rehearsal; defaults to all scoped relations")
    args = cli.parse_args()
    result = export(args.output, args.scratch, args.key_file, args.passphrase_file,
                    SCOPE["linked_source_env"](args.linked_project), args.table or ["tokentracker_*"])
    print(json.dumps({"output":str(args.output.resolve()), "snapshot_id":result["snapshot_id"],
                      "source_time_utc":result["source_time_utc"], "identity_counts":result["identity_counts"],
                      "encrypted_files":result["encrypted_files"]}))
