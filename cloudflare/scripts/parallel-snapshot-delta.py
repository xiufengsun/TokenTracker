"""Reconcile source changes with a D1 candidate that has already accepted writes."""

from collections import defaultdict
import hashlib
import json
import re


GUARD = 'tt_migration_parallel_guard'
DIRTY_TRIGGERS = ('report_hourly_', 'report_session_', 'report_device_', 'report_cluster_')


def same_value(left, right):
    if type(left) is not type(right):
        return False
    return left.hex() == right.hex() if isinstance(left, float) else left == right


def same_row(left, right):
    if left is None or right is None:
        return left is right
    return all(same_value(a, b) for a, b in zip(left, right, strict=True))


def merge_row(table, before, after, actual):
    if same_row(actual, after):
        return actual
    if same_row(actual, before):
        return after
    if any(row is None for row in (before, after, actual)):
        raise ValueError(f"Independent insert or deletion conflicts in {table}")
    merged = []
    for prior, final, current in zip(before, after, actual, strict=True):
        if same_value(prior, final):
            merged.append(current)
        elif same_value(current, prior) or same_value(current, final):
            merged.append(final)
        else:
            raise ValueError(f"Independent field changes conflict in {table}")
    return tuple(merged)


class ParallelDelta:
    def __init__(self, transfer, marker, maximum):
        self.transfer = transfer
        self.marker = marker
        self.maximum = maximum
        self.ident = transfer['ident']
        self.literal = transfer['literal']
        self.tables = {}
        self.changes = defaultdict(dict)

    def collect(self, source, table, op, fields, keys, row):
        self.tables[table] = (fields, keys)
        key = tuple(row[fields.index(k)] for k in keys)
        if None in key or key in self.changes[table]:
            raise ValueError(f"Non-unique delta key in {table}")
        before = None if op == 'insert' else row
        if op == 'update':
            before = source.execute(
                f"SELECT {','.join(map(self.ident, fields))} FROM main.{self.ident(table)} WHERE " +
                ' AND '.join(f"{self.ident(k)}=?" for k in keys), key,
            ).fetchone()
            if before is None:
                raise ValueError(f"Original delta row is missing in {table}")
        self.changes[table][key] = (before, None if op == 'delete' else row)

    def select(self, remote, table, keys):
        fields, columns = self.tables[table]
        names = ','.join(map(self.ident, columns))
        encode = ','.join(map(self.transfer['wire_column'], fields))
        query = f"SELECT json_array({encode}) AS r FROM {self.ident(table)} WHERE ({names}) IN ("
        offsets = [fields.index(k) for k in columns]
        result = {}
        keys = list(keys)
        for start in range(0, len(keys), 100):
            group = keys[start:start+100]
            terms = ','.join('(' + ','.join(map(self.literal, k)) + ')' for k in group)
            sql = query + terms + ')'
            if len(sql.encode()) >= self.transfer['MAX_SQL']:
                raise ValueError(f"Delta keys exceed the D1 statement limit in {table}")
            expected = {key: key for key in group}
            for item in remote.query(sql):
                row = tuple(map(self.transfer['decode'], json.loads(item['r'])))
                key = tuple(row[i] for i in offsets)
                if not same_row(expected.get(key), key) or key in result:
                    raise ValueError(f"Candidate primary key differs in {table}")
                result[key] = row
        return result

    def predicate(self, names, values, *, qualifier=''):
        pairs = [(qualifier + self.ident(name), self.literal(value))
                 for name, value in zip(names, values, strict=True)]
        return ' AND '.join(f"{col} IS {value} COLLATE BINARY AND typeof({col})=typeof({value})"
                            for col, value in pairs)

    def guard(self, expression):
        return f"INSERT INTO {GUARD} SELECT ({expression});"

    def cascades(self, source, ordered):
        deletes = defaultdict(list)
        for child in ordered:
            references = defaultdict(list)
            for fk in source.execute(f"PRAGMA foreign_key_list({self.ident(child)})"):
                references[fk[0]].append(fk)
            for fk in references.values():
                if fk[0][5] not in ('NO ACTION', 'RESTRICT'):
                    raise ValueError(f"Unsupported cascading parent update in {child}")
                if fk[0][6] not in ('NO ACTION', 'RESTRICT'):
                    parent = fk[0][2]
                    parent_fields = self.transfer['columns'](source, parent)[1]
                    deletes[parent].append((child, [r[3] for r in fk],
                                            [r[4] or parent_fields[r[1]] for r in fk]))
        return deletes

    def prepare(self, remote, source, objects):
        ordered = self.transfer['ordered_tables'](source, objects)
        cascades = self.cascades(source, ordered)
        checks = []
        pending = {op: defaultdict(list) for op in ('insert', 'update', 'delete')}
        expected = {}
        for table, changes in self.changes.items():
            fields, keys = self.tables[table]
            name = self.ident(table)
            current = self.select(remote, table, changes)
            desired = expected[table] = {}
            for key, (before, after) in changes.items():
                actual = current.get(key)
                merged = desired[key] = merge_row(table, before, after, actual)
                where = self.predicate(keys, key)
                match = f"SELECT 1 FROM {name} WHERE {where}"
                if actual is not None:
                    match += ' AND ' + self.predicate(fields, actual)
                checks.append(self.guard(('NOT ' if actual is None else '') + f"EXISTS ({match})"))
                if same_row(actual, merged):
                    continue
                if actual is None:
                    columns = ','.join(map(self.ident, fields))
                    values = ','.join(map(self.literal, merged))
                    insert = f"INSERT INTO {name} ({columns}) VALUES ({values});"
                    pending['insert'][table].extend(
                        [insert] if len(insert.encode()) < self.transfer['MAX_SQL'] else
                        self.transfer['oversized_statements'](table, fields, merged)
                    )
                elif merged is None:
                    for child, child_cols, parent_cols in cascades[table]:
                        ref = ' AND '.join(f"parent.{self.ident(p)}=child.{self.ident(c)}"
                                           for p,c in zip(parent_cols, child_cols, strict=True))
                        parent_key = self.predicate(keys, key, qualifier='parent.')
                        pending['delete'][table].append(self.guard(
                            f"NOT EXISTS (SELECT 1 FROM {self.ident(child)} child JOIN {name} parent "
                            f"ON {ref} WHERE {parent_key})"
                        ))
                    pending['delete'][table].append(f"DELETE FROM {name} WHERE {where};")
                else:
                    assignments = ','.join(f"{self.ident(c)}={self.literal(v)}"
                                           for c,v,old in zip(fields, merged, actual, strict=True)
                                           if not same_value(v, old))
                    pending['update'][table].append(f"UPDATE {name} SET {assignments} WHERE {where};")
        mutations = [sql for op in pending for table in (reversed(ordered) if op == 'delete' else ordered)
                     for sql in pending[op][table]]
        return checks, mutations, expected

    def verify(self, remote, expected):
        for table, rows in expected.items():
            current = self.select(remote, table, rows)
            if any(not same_row(current.get(key), row) for key, row in rows.items()):
                raise ValueError(f"Typed delta verification failed in {table}")

    def apply(self, args, source, objects, old_hash, new_hash, ensure_unchanged):
        receipt = json.loads(args.parallel_readback.read_text(encoding='utf-8-sig'))
        database = str(args.database)
        if (receipt.get('database') != database or receipt.get('name') != args.expect_name or
                not re.fullmatch('[0-9a-f]{64}', str(receipt.get('sha256')))):
            raise ValueError('D1 initial readback receipt does not match the candidate')
        remote = self.transfer['Remote'](args.account, database, self.transfer['cloudflare_token_provider'](args.cf_oauth_file))
        info = remote.api()
        if info.get('uuid') != database or info.get('name') != args.expect_name:
            raise ValueError('D1 candidate identity does not match')
        marker = self.ident(self.marker)
        initial = remote.query(f"SELECT snapshot FROM {marker} WHERE part=0")
        if initial != [{'snapshot': receipt['sha256']}]:
            raise ValueError('D1 initial checkpoint differs from the readback receipt')
        last = remote.query(f"SELECT part,sha256 FROM {marker} ORDER BY part DESC LIMIT 1")
        ddl_hash = hashlib.sha256(self.transfer['final_ddl'](objects)).hexdigest()
        if len(last) != 1 or last[0]['part'] < 2 or last[0]['sha256'] != ddl_hash:
            raise ValueError('D1 initial import is incomplete')
        version_sql = f"SELECT snapshot FROM {marker} WHERE part IN(-1,0) ORDER BY part LIMIT 1"
        version = remote.query(version_sql)[0]['snapshot']
        if version not in (old_hash, new_hash):
            raise ValueError('D1 checkpoint is for a different source snapshot')
        schema = {r['name']:(r['type'],r['sql']) for r in remote.query(
            f"SELECT type,name,sql FROM sqlite_schema WHERE {self.transfer['SYSTEM']} AND sql IS NOT NULL AND name<>?",
            [self.marker],
        )}
        if schema != objects or GUARD in objects:
            raise ValueError('D1 schema differs from the sealed source')

        checks, mutations, expected = self.prepare(remote, source, objects)
        if version == new_hash:
            if mutations:
                raise ValueError('D1 checkpoint is current but source changes need repair')
            self.verify(remote, expected)
            return 'already_verified'
        # Keep the report invalidations for changes the mirror did not apply.
        ddl = [(self.ident(n), sql.rstrip(';') + ';') for n,(kind,sql) in objects.items()
               if kind == 'trigger' and not n.startswith(DIRTY_TRIGGERS)]
        statements = [
            'PRAGMA defer_foreign_keys=ON;',
            f"CREATE TABLE {GUARD}(v INTEGER NOT NULL CHECK(v=1));",
            self.guard(f"({version_sql}) IS {self.literal(old_hash)}"),
            *checks,
            *(f"DROP TRIGGER {name};" for name,_ in ddl),
            *mutations,
            *(sql for _,sql in ddl),
            f"DROP TABLE {GUARD};",
            f"INSERT INTO {marker} VALUES(-1,'delta-parallel-v1',{self.literal(new_hash)}) "
            "ON CONFLICT(part) DO UPDATE SET sha256=excluded.sha256,snapshot=excluded.snapshot;",
        ]
        parts = [sql.encode() for sql in statements]
        if (any(len(sql) >= self.transfer['MAX_SQL'] for sql in parts) or
                sum(len(sql) + 1 for sql in parts) > self.maximum):
            raise ValueError('Guarded delta exceeds the D1 statement or import budget')
        ensure_unchanged()
        remote.upload(b'\n'.join(parts) + b'\n')
        if remote.query(version_sql) != [{'snapshot': new_hash}]:
            raise ValueError('D1 does not show the committed parallel delta')
        self.verify(remote, expected)
        return 'applied_and_verified'
