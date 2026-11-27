PRAGMA defer_foreign_keys=ON;
DROP VIEW IF EXISTS tokentracker_user_profiles;
CREATE TABLE tt_auth_accounts_copy AS SELECT * FROM tt_auth_accounts;
DROP TABLE tt_auth_accounts;
CREATE TABLE tt_auth_accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, email_verified INTEGER NOT NULL CHECK(email_verified IN (0,1)),
  profile TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(profile)), password_hash TEXT, created_at TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)), email_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(email_ambiguous IN (0,1))
) STRICT;
INSERT INTO tt_auth_accounts(id,email,email_verified,profile,password_hash,created_at,claimed)
  SELECT id,email,email_verified,profile,password_hash,created_at,claimed FROM tt_auth_accounts_copy;
DROP TABLE tt_auth_accounts_copy;
CREATE UNIQUE INDEX tt_auth_login_email ON tt_auth_accounts(email) WHERE email_ambiguous=0;
CREATE TABLE tt_auth_identity_conflicts(identity_digest TEXT PRIMARY KEY) STRICT;
CREATE VIEW tokentracker_user_profiles AS
  SELECT a.id AS user_id,COALESCE(s.display_name,json_extract(a.profile,'$.name'),substr(a.email,1,instr(a.email,'@')-1)) AS display_name,
    COALESCE(s.avatar_url,json_extract(a.profile,'$.avatar_url')) AS avatar_url
  FROM tt_auth_accounts a LEFT JOIN tokentracker_user_settings s ON s.user_id=a.id;
