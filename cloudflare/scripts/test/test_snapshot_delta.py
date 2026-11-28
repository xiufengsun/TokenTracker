"""Exercise retryable source-image deltas using synthetic, closed SQLite files."""

import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import sqlite3
from contextlib import closing
import tempfile
from types import SimpleNamespace
import unittest

MOD = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "reconcile-snapshot-delta.py")
)
PARALLEL = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "parallel-snapshot-delta.py")
)["ParallelDelta"]
SCHEMA = """
 PRAGMA foreign_keys=ON;
 CREATE TABLE tokentracker_parent (id TEXT PRIMARY KEY, title TEXT COLLATE NOCASE) STRICT;
 CREATE TABLE tokentracker_child (a TEXT, n INTEGER, parent TEXT REFERENCES tokentracker_parent ON DELETE CASCADE,
   data BLOB, money TEXT, extra INTEGER, PRIMARY KEY(a,n)) STRICT, WITHOUT ROWID;
 CREATE TABLE aggregate_flags (id INTEGER PRIMARY KEY) STRICT;
 CREATE TRIGGER dirty_ins AFTER INSERT ON tokentracker_child BEGIN INSERT OR IGNORE INTO aggregate_flags VALUES(1); END;
 CREATE TRIGGER dirty_del AFTER DELETE ON tokentracker_child BEGIN INSERT OR IGNORE INTO aggregate_flags VALUES(2); END;
 CREATE TABLE tt_auth_accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, claimed INTEGER NOT NULL DEFAULT 0) STRICT;
 CREATE TABLE tt_auth_providers (provider TEXT, sub TEXT, uid TEXT REFERENCES tt_auth_accounts(id), PRIMARY KEY(provider,sub)) STRICT;
 CREATE TABLE tt_auth_legacy (digest TEXT PRIMARY KEY, uid TEXT) STRICT;
 CREATE TABLE tt_auth_sessions (id TEXT PRIMARY KEY, uid TEXT REFERENCES tt_auth_accounts(id)) STRICT;
 CREATE TABLE tokentracker_hourly_quarantine (id TEXT, amount INTEGER) STRICT;
 CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
 INSERT INTO d1_migrations VALUES(1,'0001.sql');
"""
BUSINESS = (
    "tokentracker_parent",
    "tokentracker_child",
    "tokentracker_hourly_quarantine",
)


def seal(path, base=None):
    db = sqlite3.connect(path)
    assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
    data = dict(
        base or {},
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        bytes=path.stat().st_size,
        integrity="ok",
        failed={},
        foreign_key_errors={},
        migration_baseline=["0001.sql"],
    )
    data["tables"] = {
        name: {"rows": db.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0]}
        for name in BUSINESS
    }
    db.close()
    path.with_suffix(".json").write_text(json.dumps(data))
    return data


def fixture(dir):
    a, b = dir / "before.sqlite", dir / "after.sqlite"
    db = sqlite3.connect(a)
    db.executescript(SCHEMA)
    db.executemany(
        "INSERT INTO tokentracker_parent VALUES(?,?)",
        [("p", "Case"), ("retire", "unused"), ("stay", "unchanged")],
    )
    db.executemany(
        "INSERT INTO tokentracker_child VALUES(?,?,?,?,?,?)",
        [
            ("same", 1, "p", b"sensitive-fixture\x00", "0.1234567890123456789", 2**62),
            ("del", 1, "retire", None, "0", None),
            ("move", 2, "retire", b"move", "42", 27),
        ],
    )
    db.execute("INSERT INTO tt_auth_accounts(id,email) VALUES('u','owner@example.test')")
    db.execute("INSERT INTO tt_auth_providers VALUES('github','1','u')")
    db.execute("INSERT INTO tt_auth_legacy VALUES('digest1','u')")
    db.execute("DELETE FROM aggregate_flags")
    db.commit()
    db.close()
    shutil.copyfile(a, b)
    db = sqlite3.connect(b)
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("INSERT INTO tokentracker_parent VALUES('new','added')")
    db.execute("UPDATE tokentracker_parent SET title='case' WHERE id='p'")
    db.execute("UPDATE tokentracker_child SET parent='new' WHERE a='move'")
    db.execute(
        "UPDATE tokentracker_child SET data=?,extra=?,money=? WHERE a='same'",
        (b"\x00\xfe", 2**62 + 1, "0.1234567890123456788"),
    )
    db.execute("DELETE FROM tokentracker_parent WHERE id='retire'")
    db.execute("INSERT INTO tokentracker_child VALUES('new',2,'new',NULL,'3',4)")
    db.execute("UPDATE tt_auth_accounts SET email='OWNER@example.test' WHERE id='u'")
    db.execute("INSERT INTO tt_auth_accounts(id,email) VALUES('other','qa@example.test')")
    db.execute("UPDATE tt_auth_providers SET uid='other' WHERE sub='1'")
    db.execute("DELETE FROM tt_auth_legacy WHERE digest='digest1'")
    db.execute("DELETE FROM aggregate_flags")
    db.commit()
    db.close()
    return a, b, seal(a), seal(b)


class SnapshotDeltaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.a, self.b, self.p, self.q = fixture(self.dir)
        self.copy = self.dir / "clone.sqlite"
        shutil.copyfile(self.a, self.copy)

    def plan(self):
        return MOD["plan"](self.a, self.b, self.p, self.q, 1 << 20)

    def test_change_types_foreign_keys_triggers_and_retry(self):
        objects, sql, counts = self.plan()
        self.assertEqual(
            counts["tokentracker_parent"], {"insert": 1, "update": 1, "delete": 1}
        )
        self.assertEqual(
            counts["tokentracker_child"], {"insert": 1, "update": 2, "delete": 1}
        )
        self.assertEqual(counts["tt_auth_accounts"]["update"], 1)
        check = MOD["check_local"]
        self.assertEqual(
            check(self.a, self.b, self.copy, objects, sql), "applied_and_verified"
        )
        self.assertEqual(
            check(self.a, self.b, self.copy, objects, sql), "already_verified"
        )
        db = sqlite3.connect(self.copy)
        self.assertEqual(
            db.execute("SELECT count(*) FROM aggregate_flags").fetchone()[0], 0
        )
        self.assertEqual(
            db.execute(
                "SELECT extra FROM tokentracker_child WHERE a='same'"
            ).fetchone()[0],
            2**62 + 1,
        )
        self.assertEqual(
            db.execute(
                "SELECT parent FROM tokentracker_child WHERE a='move'"
            ).fetchone()[0],
            "new",
        )
        db.execute("DELETE FROM tokentracker_child WHERE a='same'")
        self.assertEqual(db.execute("SELECT id FROM aggregate_flags").fetchone(), (2,))
        db.close()

    def test_reject_local_drift_before_any_writes(self):
        objects, sql, _ = self.plan()
        with closing(sqlite3.connect(self.copy)) as db, db:
            db.execute(
                "UPDATE tokentracker_parent SET title='independent' WHERE id='stay'"
            )
        with self.assertRaisesRegex(ValueError, "independent"):
            MOD["check_local"](self.a, self.b, self.copy, objects, sql)
        with closing(sqlite3.connect(self.copy)) as db:
            self.assertEqual(
                db.execute(
                    "SELECT count(*) FROM tokentracker_parent WHERE id='retire'"
                ).fetchone()[0],
                1,
            )

    def test_unknown_or_keyless_changes_require_replacement(self):
        with closing(sqlite3.connect(self.b)) as db, db:
            db.execute("INSERT INTO tokentracker_hourly_quarantine VALUES('a',1)")
        with self.assertRaisesRegex(MOD["ReplacementRequired"], "stable primary key"):
            self.plan()

    def test_bad_seal_and_failed_transaction(self):
        with self.assertRaises(ValueError):
            MOD["load_proof"](self.a, self.b.with_suffix(".json"))
        objects, sql, _ = self.plan()
        with self.assertRaises(MOD["ReplacementRequired"]):
            MOD["check_local"](
                self.a,
                self.b,
                self.copy,
                objects,
                [*sql, "INSERT INTO tokentracker_parent VALUES('p','duplicate')"],
            )
        self.assertEqual(
            MOD["check_local"](self.a, self.b, self.copy, objects, sql),
            "applied_and_verified",
        )

    def parallel_fixture(self, db):
        marker = MOD["MARKER"]
        target_id = "test-d1"
        receipt = self.dir / "d1-readback.json"
        receipt.write_text(json.dumps({"database": target_id, "name": target_id, "sha256": self.p["sha256"]}))
        with db:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute(f"CREATE TABLE {marker}(part INTEGER PRIMARY KEY,sha256 TEXT,snapshot TEXT)")
            db.execute(f"INSERT INTO {marker} VALUES(0,'initial',?)", (self.p["sha256"],))

        class Candidate:
            writes = 0
            before_upload = None

            def api(self):
                return {"uuid": target_id, "name": target_id}

            def query(self, sql, params=()):
                cursor = db.execute(sql, params)
                names = [col[0] for col in cursor.description]
                return [dict(zip(names,row,strict=True)) for row in cursor]

            def upload(self, body):
                self.writes += 1
                if self.before_upload:
                    self.before_upload()
                try:
                    db.executescript('BEGIN;\n' + body.decode() + '\nCOMMIT;')
                except sqlite3.Error:
                    db.rollback()
                    raise

        remote = Candidate()
        transfer = dict(MOD['TRANSFER'], Remote=lambda *_: remote, cloudflare_token_provider=lambda _: None)
        delta = PARALLEL(transfer, marker, 1 << 20)
        objects, _, _ = MOD["plan"](self.a, self.b, self.p, self.q, 1 << 20, on_change=delta.collect)
        with db:
            db.execute(f"INSERT INTO {marker} VALUES(2,?,?)",
                       (hashlib.sha256(transfer['final_ddl'](objects)).hexdigest(), self.p['sha256']))

        def apply():
            args = SimpleNamespace(parallel_readback=receipt, database=target_id, account="test",
                                   expect_name=target_id, cf_oauth_file=None)
            with closing(MOD['open_image'](self.a)) as source:
                return delta.apply(args, source, objects, self.p['sha256'], self.q['sha256'], lambda: None)
        return remote, apply

    def test_parallel_delta_preserves_native_sessions_and_skips_replayed_rows(self):
        with closing(sqlite3.connect(self.copy)) as db:
            remote, apply = self.parallel_fixture(db)
            with db:
                db.execute("UPDATE tt_auth_accounts SET claimed=1 WHERE id='u'")
                db.execute("INSERT INTO tt_auth_sessions VALUES('active','u')")
                db.execute("INSERT INTO tt_auth_accounts VALUES('native','native@example.test',1)")
                db.execute("UPDATE tokentracker_child SET extra=? WHERE a='same'", (2**62 + 1,))
                db.execute("DELETE FROM tokentracker_child WHERE a='del'")
                db.execute("DELETE FROM aggregate_flags")
            self.assertEqual(apply(), 'applied_and_verified')
            self.assertEqual(apply(), 'already_verified')
            self.assertEqual(remote.writes, 1)
            self.assertEqual(db.execute("SELECT uid FROM tt_auth_sessions WHERE id='active'").fetchone(), ('u',))
            self.assertEqual(db.execute("SELECT email,claimed FROM tt_auth_accounts WHERE id='u'").fetchone(),
                             ('OWNER@example.test', 1))
            self.assertEqual(db.execute("SELECT claimed FROM tt_auth_accounts WHERE id='native'").fetchone(), (1,))
            self.assertEqual(db.execute("SELECT data,extra FROM tokentracker_child WHERE a='same'").fetchone(),
                             (b'\x00\xfe', 2**62 + 1))

    def test_parallel_delta_rejects_conflicting_changes_before_upload(self):
        with closing(sqlite3.connect(self.copy)) as db:
            remote, apply = self.parallel_fixture(db)
            with db:
                db.execute("UPDATE tt_auth_accounts SET email='independent@example.test' WHERE id='u'")
            with self.assertRaisesRegex(ValueError, "field changes conflict"):
                apply()
            self.assertEqual(remote.writes, 0)

    def test_parallel_delta_rolls_back_unsafe_cascade_and_race(self):
        with closing(sqlite3.connect(self.copy)) as db:
            remote, apply = self.parallel_fixture(db)
            with db:
                db.execute("INSERT INTO tokentracker_child VALUES('native',1,'retire',NULL,'2',NULL)")
            with self.assertRaises(sqlite3.IntegrityError):
                apply()
            self.assertEqual(db.execute("SELECT parent FROM tokentracker_child WHERE a='native'").fetchone(), ('retire',))
            self.assertEqual(db.execute(f"SELECT count(*) FROM {MOD['MARKER']} WHERE part=-1").fetchone(), (0,))
            with db:
                db.execute("DELETE FROM tokentracker_child WHERE a='native'")

            def race():
                with db:
                    db.execute("UPDATE tt_auth_accounts SET claimed=1 WHERE id='u'")

            remote.before_upload = race
            with self.assertRaises(sqlite3.IntegrityError):
                apply()
            self.assertEqual(db.execute("SELECT claimed FROM tt_auth_accounts WHERE id='u'").fetchone(), (1,))
            self.assertEqual(db.execute(f"SELECT count(*) FROM {MOD['MARKER']} WHERE part=-1").fetchone(), (0,))


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
