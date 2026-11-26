"""Build a private identity migration file on the operator's encrypted volume."""
import argparse
from collections import defaultdict
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3

def project(out,key_file,pg_env,snapshot=None):
    if out.exists():
        raise ValueError("Choose a new identity database path")
    key=json.loads(key_file.read_text())["AUTH_MIGRATION_KEY"].encode()
    if len(key)<32:
        raise ValueError("A deployment-specific migration key of at least 32 bytes is required")
    scope=runpy.run_path(str(Path(__file__).with_name("audit-account-scope.py")))
    account_ids=scope["account_ids"]
    columns=scope["ownership_columns"](pg_env,snapshot)
    # Only select password material for confirmed TokenTracker accounts. Exclude external
    # access/refresh tokens, project administration flags, and unrelated provider data.
    query=f"""WITH t AS ({account_ids('tokentracker_',columns)}), a AS ({account_ids('agentmeter_',columns)})
        SELECT u.id, u.email, u.email_verified, u.created_at, (t.uid IS NOT NULL) AS active,
        CASE WHEN t.uid IS NOT NULL THEN u.password END AS password,
        CASE WHEN t.uid IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('name',u.profile->>'name',
            'avatar_url',u.profile->>'avatar_url')) END AS profile,
        coalesce((SELECT json_agg(json_build_array(p.provider,p.provider_account_id)) FROM auth.user_providers p
          WHERE p.user_id=u.id AND p.provider IN ('google','github') AND p.provider_account_id<>''),'[]') AS identities
        FROM auth.users u LEFT JOIN t ON t.uid=u.id LEFT JOIN a ON a.uid=u.id
        WHERE (t.uid IS NOT NULL OR a.uid IS NULL) AND NOT u.is_anonymous"""
    rows=scope["rows"](query,pg_env,snapshot)
    temp=out.with_suffix(".partial.sqlite")
    if temp.exists():
        raise ValueError("Previous incomplete projection still exists at the temporary path")
    db=sqlite3.connect(temp)
    root=Path(__file__).resolve().parents[1]/"migrations"
    for schema in ["0003_account_auth.sql","0004_legacy_identities.sql","0041_auth_ambiguous_email.sql"]:
        db.executescript((root/schema).read_text())
    owners=defaultdict(set)
    for item in rows:
        email=(item["email"] or "").strip().lower()
        if email: owners[("email",email)].add(item["id"])
        for provider,subject in item["identities"]: owners[(provider,subject)].add(item["id"])
    for (kind,value), users in owners.items():
        hashed=base64.urlsafe_b64encode(hmac.digest(key,(kind+'\0'+value).encode(),hashlib.sha256)).rstrip(b'=').decode()
        if len(users)==1:
            db.execute("INSERT INTO tt_auth_legacy VALUES(?,?)",(hashed,next(iter(users))))
        else:
            db.execute("INSERT INTO tt_auth_identity_conflicts VALUES(?)",(hashed,))
    result={"confirmed":0,"pending":0,"provider_links":0,"supported_passwords":0,"unsupported_passwords":0,"no_proof_address_or_subject":0}
    with db:
        for row in rows:
            user=row["id"]; email=(row["email"] or "").strip().lower()
            if not email and not row["identities"]:
                result["no_proof_address_or_subject"]+=1
            if not row["active"]:
                result["pending"]+=1
                continue
            result["confirmed"]+=1
            password=row["password"]
            if password and not re.fullmatch(r'\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}',password):
                result["unsupported_passwords"]+=1
                password=None
            if password: result["supported_passwords"]+=1
            db.execute("INSERT INTO tt_auth_accounts(id,email,email_verified,profile,password_hash,created_at,claimed,email_ambiguous) VALUES(?,?,?,?,?,?,1,?)",
                (user,row["email"] or "",int(row["email_verified"]),json.dumps(row["profile"] or {}),password,row["created_at"],int(len(owners[("email",email)])>1)))
            for provider,subject in row["identities"]:
                if len(owners[(provider,subject)])!=1: continue
                db.execute("INSERT INTO tt_auth_providers VALUES(?,?,?)",(provider,subject,user))
                result["provider_links"]+=1
    assert db.execute("PRAGMA integrity_check").fetchone()==("ok",)
    assert db.execute("SELECT count(*) FROM tt_auth_accounts").fetchone()[0]==result["confirmed"]
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
    db.close()
    os.rename(temp,out)
    result["conflicting_identities"]=sum(len(v)>1 for v in owners.values())
    return result

if __name__=="__main__":
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",required=True,type=Path)
    parser.add_argument("--key-file",required=True,type=Path,help="Private JSON containing AUTH_MIGRATION_KEY")
    args=parser.parse_args()
    scope=runpy.run_path(str(Path(__file__).with_name("audit-account-scope.py")))
    print(json.dumps(project(args.out,args.key_file,scope["linked_source_env"]())))
