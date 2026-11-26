"""Test a post-snapshot concurrent commit on an isolated local PostgreSQL instance."""
import contextlib
import json
import os
from pathlib import Path
import runpy
import secrets
import sqlite3
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "export-consistent-snapshot.py"
MODULE = runpy.run_path(str(SCRIPT))
LOCAL_PG_HOST = runpy.run_path(str(SCRIPT.with_name("migration-platform.py")))["local_pg_host"]
A = "22452186-fcd0-463b-a81e-cfc9cc20aca0"
B = "cbdad40a-8c99-42b0-b4b5-685852ffd9fb"
EXCLUDED = "413f9265-1091-4cbb-85a3-afb5a822de16"


class SourceSnapshotTest(unittest.TestCase):
    def setUp(self):
        socket = os.environ.get("TT_TEST_PG_SOCKET", "")
        try:
            host = LOCAL_PG_HOST(socket)
        except ValueError:
            self.skipTest("Set TT_TEST_PG_SOCKET to the disposable local PostgreSQL host or socket")
        self.local = dict(os.environ, PGHOST=host, PGPORT=os.environ["TT_TEST_PG_PORT"],
                          PGDATABASE="postgres", PGCLIENTENCODING="UTF8")
        self.testdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.testdir.cleanup)
        self.folder = Path(self.testdir.name)
        self.source = self.create_database()
        self.restore = self.create_database()

    def create_database(self):
        db = "tt_snapshot_test_" + uuid.uuid4().hex
        subprocess.run(["createdb", db], env=self.local, check=True)
        self.addCleanup(subprocess.run, ["dropdb", db], env=self.local, check=True)
        return dict(self.local, PGDATABASE=db)

    def sql(self, env, sql):
        return subprocess.check_output(["psql", "-XqAt", "--set=ON_ERROR_STOP=1"], env=env, input=sql, text=True).strip()

    def test_same_cutoff_across_dump_and_identities(self):
        key = self.folder / "key"
        key.write_text(json.dumps({"AUTH_MIGRATION_KEY": secrets.token_hex(32)}))
        key.chmod(0o600)
        passphrase = self.folder / "pass"
        passphrase.write_text(secrets.token_hex(32))
        passphrase.chmod(0o600)
        self.sql(self.source, f"""
          CREATE SCHEMA auth;
          CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_verified boolean,created_at timestamptz DEFAULT now(),
                                  password text,profile jsonb DEFAULT '{{}}',is_anonymous boolean DEFAULT false);
          CREATE TABLE auth.user_providers(user_id uuid, provider text,provider_account_id text,access_token text,refresh_token text);
          CREATE TABLE public.agentmeter_sample(user_id uuid PRIMARY KEY);
          CREATE TABLE public.tokentracker_sample(user_id uuid PRIMARY KEY,n integer);
          INSERT INTO auth.users(id,email,email_verified) VALUES ('{A}','a@example.test',true),('{EXCLUDED}','excluded@example.test',true);
          INSERT INTO public.tokentracker_sample VALUES ('{A}',10);
          INSERT INTO public.agentmeter_sample VALUES ('{EXCLUDED}');
          INSERT INTO auth.user_providers VALUES ('{A}','github','uid_a','sensitive-marker-1','sensitive-marker-2');
        """)
        lease = MODULE["snapshot_lease"]

        @contextlib.contextmanager
        def with_concurrent_commit(env):
            with lease(env) as snapshot:
                # A separate PostgreSQL connection commits BEFORE either export starts.
                self.sql(self.source, f"""BEGIN;
                    INSERT INTO auth.users(id,email,email_verified) VALUES ('{B}','new@example.test',true);
                    UPDATE public.tokentracker_sample SET n=20 WHERE user_id='{A}';
                    INSERT INTO public.tokentracker_sample VALUES ('{B}',30);
                    COMMIT;""")
                yield snapshot

        out = self.folder / "sealed"
        with patch.dict(MODULE["export"].__globals__, snapshot_lease=with_concurrent_commit):
            receipt = MODULE["export"](out,self.folder,key,passphrase,self.source,["tokentracker_sample"])
        self.assertEqual(receipt["identity_counts"]["confirmed"], 1)
        self.assertEqual(receipt["identity_counts"]["pending"], 0)
        self.assertEqual(receipt["identity_counts"]["provider_links"], 1)
        self.assertEqual(self.sql(self.source,"SELECT sum(n) FROM tokentracker_sample"), "50")
        self.assertEqual(self.sql(self.source,"SELECT count(*) FROM auth.users"), "3")
        decrypt = MODULE["gpg_command"](passphrase) + ["--decrypt"]
        database = self.folder / "restored.sqlite"
        with database.open("wb") as f:
            subprocess.run(decrypt + [str(out / "identities.sqlite.gpg")],stdout=f,check=True)
        with contextlib.closing(sqlite3.connect(database)) as identities:
            self.assertEqual(identities.execute("SELECT id,email FROM tt_auth_accounts").fetchall(),[(A,"a@example.test")])
            self.assertEqual(identities.execute("SELECT provider,subject FROM tt_auth_providers").fetchall(),[("github","uid_a")])
            self.assertFalse(any("sensitive-marker" in line for line in identities.iterdump()))
        archived = subprocess.check_output(decrypt + [str(out / "business.dump.gpg")])
        ddl = subprocess.check_output(["pg_restore","--no-owner","--no-privileges","-f","-"],input=archived).decode()
        self.sql(self.restore,ddl.replace("SET transaction_timeout = 0;",""))
        self.assertEqual(self.sql(self.restore,"SELECT user_id::text||':'||n FROM tokentracker_sample"),A+":10")
        self.assertEqual(self.sql(self.restore,"SELECT count(*) FROM pg_tables WHERE tablename LIKE 'agentmeter_%'"),"0")


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
