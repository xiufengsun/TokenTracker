CREATE TABLE IF NOT EXISTS tt_auth_accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email_verified INTEGER NOT NULL CHECK(email_verified IN (0,1)),
  profile TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(profile)),
  password_hash TEXT, created_at TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS tt_auth_providers (
  provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES tt_auth_accounts(id),
  PRIMARY KEY(provider,subject)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tt_auth_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES tt_auth_accounts(id), refresh_digest TEXT NOT NULL UNIQUE,
  csrf_digest TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS tt_auth_session_user ON tt_auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS tt_auth_oauth (
  state TEXT PRIMARY KEY, provider TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
  verifier TEXT NOT NULL, cookie_digest TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tt_auth_exchange (
  digest TEXT PRIMARY KEY, challenge TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES tt_auth_accounts(id),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tt_auth_email_codes (
  email TEXT NOT NULL COLLATE NOCASE, purpose TEXT NOT NULL, digest TEXT NOT NULL,
  pending_password TEXT, expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL, remaining INTEGER NOT NULL,
  PRIMARY KEY(email,purpose)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tt_auth_reset_tokens (
  digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES tt_auth_accounts(id), expires_at INTEGER NOT NULL
) STRICT;
