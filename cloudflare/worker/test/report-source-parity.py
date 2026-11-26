"""Compare private report rows from the deployed PostgreSQL function and the Worker query on the same snapshot."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit
import uuid

target = Path(__file__).resolve().parents[1]
cli = subprocess.run(["npx","@insforge/cli","db","connection-string","--json"],capture_output=True,check=True,text=True)
conn = urlsplit(json.loads(cli.stdout)["connectionURL"])
env = dict(os.environ, PGHOST=conn.hostname, PGPORT=str(conn.port or 5432), PGDATABASE=unquote(conn.path[1:]),
           PGUSER=unquote(conn.username),PGPASSWORD=unquote(conn.password),PGSSLMODE="verify-full",PGSSLROOTCERT="system",
           PGCONNECT_TIMEOUT="10",PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=90s")
fields = ["total_tokens","input_tokens","output_tokens","cached_input_tokens","cache_creation_input_tokens","reasoning_output_tokens","conversations"]
window = "h.hour_start >= '2026-10-31Z' AND h.hour_start < '2026-11-04Z'"
iso = lambda f: f"""to_char({f} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')"""
cases = [
    ("hour","America/New_York",0,"2026-11-01","2026-11-01"),
    ("day","Asia/Kathmandu",0,"2026-11-01","2026-11-02"),
    ("day",None,-480,"2026-11-01","2026-11-02"),
    ("month",None,0,"2026-11-01","2026-11-02"),
]
def expected(trunc,tz,offset,lo,hi):
    z = f"'{tz}'" if tz else "NULL"
    start = f"'{lo}'::timestamptz"+("" if trunc=="month" else "-interval '1 day'")
    end = f"'{hi}'::timestamptz+interval '"+("1" if trunc=="month" else "2")+" days'"
    bounds = ("true" if trunc=="month" else f"left(e->>'bucket',10) BETWEEN '{lo}' AND '{hi}'")
    return f"""(SELECT coalesce(json_agg(e),'[]') FROM jsonb_array_elements(public.account_usage_grouped_v2(c.user_id,NULL,
    {start},{end},'{trunc}',{z},{offset})) e WHERE {bounds})"""
query = f"""
WITH representative AS MATERIALIZED (
 SELECT h.user_id FROM tokentracker_hourly h WHERE {window}
 AND EXISTS(SELECT 1 FROM tokentracker_devices d WHERE d.user_id=h.user_id AND d.revoked_at IS NULL)
 GROUP BY h.user_id HAVING count(*) BETWEEN 15 AND 250
 ORDER BY count(DISTINCT h.device_id) DESC,count(DISTINCT h.source) DESC,h.user_id LIMIT 3
), canonical_sessions AS (
 SELECT s.user_id FROM tokentracker_account_session_states s WHERE s.bucket_start>='2026-11-01Z' AND s.bucket_start<'2026-11-03Z'
 AND EXISTS(SELECT 1 FROM tokentracker_devices d WHERE d.user_id=s.user_id AND d.revoked_at IS NULL)
 GROUP BY s.user_id ORDER BY count(*) DESC,s.user_id LIMIT 1
), cohort AS MATERIALIZED (SELECT user_id FROM representative UNION SELECT user_id FROM canonical_sessions)
SELECT json_build_object(
 'users',(SELECT json_agg(c.user_id) FROM cohort c),
 'hourly',(SELECT json_agg(json_build_array(h.user_id,h.device_id,h.source,h.model,{iso("h.hour_start")},{",".join("h."+c for c in fields)},{iso("h.updated_at")})) FROM tokentracker_hourly h JOIN cohort c USING(user_id) WHERE {window}),
 'devices',(SELECT json_agg(json_build_array(d.id,d.user_id,d.revoked_at IS NOT NULL)) FROM tokentracker_devices d JOIN cohort c USING(user_id)),
 'machine',(SELECT json_agg(json_build_array(m.device_id,m.machine_cluster_id)) FROM tokentracker_device_machine m JOIN tokentracker_devices d ON d.id=m.device_id JOIN cohort c ON c.user_id=d.user_id),
 'sessions',(SELECT json_agg(json_build_array(s.user_id,s.source,s.model,{iso("s.bucket_start")},{",".join("s."+c for c in fields[:-1])})) FROM tokentracker_account_session_states s JOIN cohort c USING(user_id) WHERE s.bucket_start>='2026-10-31Z' AND s.bucket_start<'2026-11-04Z'),
 'expected',(SELECT json_agg(json_build_array({",".join(expected(*case) for case in cases)}) ORDER BY c.user_id) FROM cohort c),
 'order',(SELECT json_agg(user_id ORDER BY user_id) FROM cohort)
)
"""
res=subprocess.run(["psql","-XqAt","-v","ON_ERROR_STOP=1","-c",query],capture_output=True,text=True,env=env)
if res.returncode: raise RuntimeError(res.stderr)
fixture=json.loads(res.stdout)
if not fixture["users"]: raise ValueError("No qualifying cohort")
fixture["cases"]=cases
# Stored local test data uses ephemeral surrogate account, cluster and device IDs.
remap={}
def mapped(label,value):
    return remap.setdefault((label,value),str(uuid.uuid4()))
fixture["order"]=[mapped("user",u) for u in fixture["order"]]
fixture.pop("users")
for row in fixture["hourly"]:
    row[0],row[1]=mapped("user",row[0]),mapped("device",row[1])
for row in fixture["devices"]:
    row[0],row[1]=mapped("device",row[0]),mapped("user",row[1])
for row in fixture["machine"] or []:
    row[0],row[1]=mapped("device",row[0]),mapped("cluster",row[1])
for row in fixture["sessions"] or []: row[0]=mapped("user",row[0])
with tempfile.TemporaryDirectory(prefix="tt-report-parity-") as d:
    path=Path(d,"input.json")
    path.write_text(json.dumps(fixture))
    subprocess.run(["node",str(target/"test/report-source-parity.mjs"),str(path)],check=True)
