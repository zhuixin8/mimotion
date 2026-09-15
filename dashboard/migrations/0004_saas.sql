-- License identity survives removal of Zepp credentials/profile: expiry and bans
-- cannot be reset by deleting and registering the same Zepp account again.
CREATE TABLE memberships (
  account_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX membership_expiry ON memberships(suspended,expires_at);
INSERT INTO memberships(account_id,expires_at,created_at,updated_at)
  SELECT id,unixepoch()+604800,unixepoch(),unixepoch() FROM accounts;
CREATE TABLE activation_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  encrypted_code TEXT NOT NULL,
  duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 3650),
  batch_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  valid_until INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  redeemed_by TEXT,
  redeemed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX activation_created ON activation_codes(created_at DESC,id);
CREATE INDEX activation_redeemed ON activation_codes(redeemed_by);
CREATE TABLE license_redemptions (
  code_id TEXT PRIMARY KEY REFERENCES activation_codes(id),
  account_id TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  previous_expiry INTEGER NOT NULL,
  new_expiry INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX redemptions_account ON license_redemptions(account_id,created_at DESC);
CREATE TABLE admin_auth (
  id INTEGER PRIMARY KEY CHECK(id=1),
  key_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_created ON admin_audit(created_at DESC,id);
CREATE TRIGGER activation_once BEFORE UPDATE OF redeemed_by,redeemed_at ON activation_codes
WHEN OLD.redeemed_by IS NOT NULL AND (NEW.redeemed_by IS NOT OLD.redeemed_by OR NEW.redeemed_at IS NOT OLD.redeemed_at)
BEGIN
  SELECT RAISE(ABORT,'activation already redeemed');
END;
CREATE TRIGGER activation_extend AFTER UPDATE OF redeemed_by ON activation_codes
WHEN OLD.redeemed_by IS NULL AND NEW.redeemed_by IS NOT NULL
BEGIN
  INSERT INTO license_redemptions(code_id,account_id,duration_days,previous_expiry,new_expiry,created_at)
    SELECT NEW.id,account_id,NEW.duration_days,expires_at,MAX(expires_at,NEW.redeemed_at)+NEW.duration_days*86400,NEW.redeemed_at
    FROM memberships WHERE account_id=NEW.redeemed_by;
  UPDATE memberships SET expires_at=MAX(expires_at,NEW.redeemed_at)+NEW.duration_days*86400,
    updated_at=NEW.redeemed_at,revision=revision+1 WHERE account_id=NEW.redeemed_by;
  INSERT INTO admin_audit(id,actor,action,target,details,created_at)
    VALUES(lower(hex(randomblob(16))),'user','redeem',NEW.redeemed_by,json_object('code_id',NEW.id,'days',NEW.duration_days),NEW.redeemed_at);
END;
