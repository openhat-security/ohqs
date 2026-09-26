-- API tokens + usage audit for Keycloak-backed OHQS auth.
-- Raw tokens are NEVER stored — only SHA-256 hex hashes.

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  email TEXT,
  type TEXT NOT NULL CHECK (type IN ('client', 'ai_admin')),
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_by_sub TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_sub);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  user_sub TEXT,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  status INTEGER,
  bytes INTEGER,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_usage_token ON api_usage(token_id, ts);
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage(user_sub, ts);
