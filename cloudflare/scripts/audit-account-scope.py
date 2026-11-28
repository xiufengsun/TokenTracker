"""Count account ownership signals on the linked source. Prints aggregate counts only."""
import json
import os
import re
import runpy
from pathlib import Path
from urllib.parse import unquote, urlsplit
import subprocess
import time

NPM = runpy.run_path(str(Path(__file__).with_name("migration-platform.py")))["npx_command"]


def linked_source_env(project_dir=None):
    # Never pass the database password in argv, output files or diagnostic messages.
    directory = Path(project_dir or Path.cwd())
    link = json.loads((directory / ".insforge/project.json").read_text())
    if link.get("appkey") != "srctyff5":
        raise ValueError("Expected the linked TokenTracker production project")
    for attempt in range(5):
        try:
            result = subprocess.run(
                [NPM(), "--yes", "@insforge/cli", "db", "connection-string", "--json"],
                cwd=directory, encoding="utf-8", capture_output=True, check=False, timeout=45,
            )
        except subprocess.TimeoutExpired:
            result = None
        if result and result.returncode == 0:
            connection = json.loads(result.stdout)
            break
        if attempt == 4:
            raise RuntimeError("InsForge did not provide the database credentials for the linked project")
        time.sleep(0.5 * (attempt + 1))
    url = urlsplit(connection["connectionURL"])
    if not url.hostname or url.hostname != "srctyff5.us-east.database.insforge.app":
        raise ValueError("Unexpected linked database endpoint")
    return dict(os.environ, PGHOST=url.hostname, PGPORT=str(url.port or 5432),
                PGDATABASE=unquote(url.path[1:]), PGUSER=unquote(url.username),
                PGPASSWORD=unquote(url.password), PGSSLMODE="verify-full",
                PGSSLROOTCERT=os.environ.get("TT_MIGRATION_CA_BUNDLE") or "system",
                PGCLIENTENCODING="UTF8", PGCONNECT_TIMEOUT="10", PGAPPNAME="tokentracker-scoped-migration",
                PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120000 -c timezone=UTC")


def rows(sql, pg_env, snapshot=None):
    statements = ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"]
    if snapshot:
        if not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+", snapshot):
            raise ValueError("Unexpected PostgreSQL snapshot identifier")
        statements.append(f"SET TRANSACTION SNAPSHOT '{snapshot}';")
    statements.extend([f"SELECT row_to_json(r) FROM ({sql}) AS r;", "COMMIT;"])
    for attempt in range(6):
        try:
            result = subprocess.run(
                ["psql", "-XqAt", "--no-password", "--set=ON_ERROR_STOP=1"],
                input="\n".join(statements), env=pg_env, capture_output=True, encoding="utf-8", timeout=150,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("The snapshot consumer did not complete within 150 seconds") from error
        if result.returncode == 0:
            return [json.loads(line) for line in result.stdout.split("\n") if line]
        if result.returncode != 2 or attempt == 5:
            raise RuntimeError(result.stderr.strip())
        # The exporting PostgreSQL session still owns the snapshot.
        time.sleep(min(10, 1 + attempt * 2))


def ownership_columns(pg_env, snapshot=None):
    return rows("""
    SELECT c.relname AS relation, a.attname AS column
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND a.atttypid = 'uuid'::regtype AND a.attnum > 0 AND NOT a.attisdropped
      AND (a.attname = 'user_id' OR a.attname LIKE '%\\_user_id' ESCAPE '\\')
    ORDER BY 1,2
""", pg_env, snapshot)

def account_ids(prefix, columns):
    sources = []
    for column in columns:
        table, field = column["relation"], column["column"]
        if not table.startswith(prefix) or re.search(r'_(?:bak|backup)_', table):
            continue
        for identifier in (table, field):
            if not re.fullmatch(r'[a-z0-9_]+', identifier):
                raise ValueError("Unexpected source identifier")
        sources.append(f'SELECT DISTINCT "{field}" AS uid FROM public."{table}" WHERE "{field}" IS NOT NULL')
    if not sources:
        raise ValueError("No account ownership tables found")
    return " UNION ".join(sources)

def count_query(columns):
    return f"""
    WITH t AS ({account_ids("tokentracker_", columns)}), a AS ({account_ids("agentmeter_", columns)})
    SELECT count(*) AS auth_accounts,
           count(*) FILTER (WHERE t.uid IS NOT NULL AND a.uid IS NULL) AS tokentracker_only,
           count(*) FILTER (WHERE t.uid IS NOT NULL AND a.uid IS NOT NULL) AS shared,
           count(*) FILTER (WHERE t.uid IS NULL AND a.uid IS NOT NULL) AS agentmeter_only,
           count(*) FILTER (WHERE t.uid IS NULL AND a.uid IS NULL) AS no_table_reference,
           count(*) FILTER (WHERE t.uid IS NULL AND a.uid IS NULL AND NOT COALESCE(u.email_verified,false)
             AND NOT EXISTS (SELECT 1 FROM auth.user_providers p WHERE p.user_id=u.id
                 AND p.provider IN ('github','google') AND nullif(trim(p.provider_account_id),'') IS NOT NULL)
           ) AS unreferenced_without_verified_email_or_oauth
    FROM auth.users u LEFT JOIN t ON t.uid = u.id LEFT JOIN a ON a.uid = u.id
"""
if __name__ == "__main__":
    env = linked_source_env()
    print(json.dumps(rows(count_query(ownership_columns(env)), env)[0]))
