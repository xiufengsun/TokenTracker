-- Pending identities need only a keyed lookup and the original account ID until proof.
CREATE TABLE IF NOT EXISTS tt_auth_legacy (
  identity_digest TEXT PRIMARY KEY, user_id TEXT NOT NULL
) STRICT;
