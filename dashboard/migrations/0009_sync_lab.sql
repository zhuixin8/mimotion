-- Mutation claims survive deleting/recreating the local account (as memberships do).
-- This prevents repeating an uncertain upstream POST after local deletion.
CREATE TABLE sync_lab_claims (
  account_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,slot)
);
CREATE TABLE sync_lab_operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('inspect','bind','append')),
  day TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  evidence TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX sync_lab_account_time ON sync_lab_operations(account_id,created_at DESC);
