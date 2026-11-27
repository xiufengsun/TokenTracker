"""Recompute the source community response in temporary tables on the private restore."""
import argparse, json, os, re, subprocess
from pathlib import Path
from urllib.parse import unquote,urlsplit

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--socket",type=Path,required=True)
parser.add_argument("--port",required=True)
parser.add_argument("--database",required=True)
parser.add_argument("--receipt",type=Path,required=True)
args=parser.parse_args()
if not args.socket.is_absolute() or not re.fullmatch(r'tt_restore_[a-f0-9]+',args.database):parser.error("Use a local restore")
os.umask(0o077)
src=urlsplit(json.loads(subprocess.check_output(["npx","@insforge/cli","db","connection-string","--json"]))["connectionURL"])
env=dict(os.environ,PGHOST=src.hostname,PGPORT=str(src.port or 5432),PGDATABASE=unquote(src.path[1:]),PGUSER=unquote(src.username),
    PGPASSWORD=unquote(src.password),PGSSLMODE="verify-full",PGSSLROOTCERT="system",PGOPTIONS="-c default_transaction_read_only=on")
functions={}
for n in ["refresh_tokentracker_community_stats","normalize_tokentracker_community_growth","leaderboard_hourly_dedup_v2"]:
    sql=f"SELECT pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='{n}'"
    f=subprocess.check_output(["psql","-XqAt","-v","ON_ERROR_STOP=1","-c",sql],env=env,text=True)
    if not f.startswith("CREATE OR REPLACE FUNCTION public."):raise AssertionError("Missing source routine")
    functions[n]=f
# All function definitions and refreshed rows are temporary and the transaction rolls back.
stmt="BEGIN; SET LOCAL timezone='UTC'; SET LOCAL statement_timeout='5min';"
stmt+="CREATE TEMP TABLE community_output AS TABLE public.tokentracker_community_stats WITH NO DATA;"
stmt+="CREATE UNIQUE INDEX ON community_output(id);"
for name in ["leaderboard_hourly_dedup_v2","normalize_tokentracker_community_growth","refresh_tokentracker_community_stats"]:
    ddl=functions[name].replace('FUNCTION public.'+name,'FUNCTION pg_temp.'+name,1)
    ddl=ddl.replace('public.leaderboard_hourly_dedup_v2(','pg_temp.leaderboard_hourly_dedup_v2(')
    ddl=ddl.replace('INSERT INTO public.tokentracker_community_stats','INSERT INTO pg_temp.community_output')
    stmt+=ddl+';'
stmt+="CREATE TRIGGER growth BEFORE INSERT OR UPDATE OF daily_growth ON pg_temp.community_output FOR EACH ROW EXECUTE FUNCTION pg_temp.normalize_tokentracker_community_growth();"
stmt+="DO $$ BEGIN PERFORM pg_temp.refresh_tokentracker_community_stats(); END $$;"
stmt+="""SELECT json_build_object('top_models',top_models,'providers',provider_breakdown,'daily_growth',daily_growth,
 'token_mix',token_mix,'user_distribution',user_distribution,'platforms',platform_distribution,'total_tokens',total_tokens,
 'active_developers_total',active_developers_total,'active_developers_30d',active_developers_30d,'tokens_30d',tokens_30d,
 'token_growth_pct',token_growth_pct,'developer_growth_pct',developer_growth_pct,'period','total','from',from_day,'to',to_day)
 FROM pg_temp.community_output WHERE id='total';ROLLBACK;"""
localEnv={k:v for k,v in os.environ.items() if not k.startswith("PG")}
localEnv.update(PGHOST=str(args.socket),PGPORT=args.port,PGDATABASE=args.database)
result=subprocess.run(["psql","-XqAt","-v","ON_ERROR_STOP=1"],input=stmt,text=True,env=localEnv,capture_output=True)
if result.returncode:raise SystemExit(result.stderr[:700])
output=json.loads(result.stdout)
assert output["total_tokens"]>0 and len(output["daily_growth"])==30
args.receipt.write_text(json.dumps(output,ensure_ascii=False))
print(json.dumps({"source_recomputed":True,"fields":len(output),"tokens":output["total_tokens"],"providers":len(output["providers"])}))
