CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  credentials TEXT NOT NULL,
  min_step INTEGER NOT NULL DEFAULT 18000,
  max_step INTEGER NOT NULL DEFAULT 25000,
  enabled INTEGER NOT NULL DEFAULT 0,
  needs_login INTEGER NOT NULL DEFAULT 0,
  session_version TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(min_step >= 0 AND min_step <= max_step AND max_step <= 100000)
);
CREATE INDEX accounts_enabled ON accounts(enabled, needs_login);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  step INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT NOT NULL DEFAULT '等待执行',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, slot)
);
CREATE INDEX runs_account ON runs(account_id, created_at DESC);
CREATE INDEX runs_outbox ON runs(status, updated_at);
CREATE TABLE rate_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX rate_expiry ON rate_limits(expires_at);
