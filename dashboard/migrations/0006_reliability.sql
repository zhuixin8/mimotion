ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'preparing';
ALTER TABLE runs ADD COLUMN execution_id TEXT;
ALTER TABLE runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN auto_checks_scheduled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN auto_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN error_code TEXT;
-- Old running jobs may already have submitted. Never replay them after migration.
UPDATE runs SET phase=CASE WHEN status='running' OR status='unknown' THEN 'submitting' WHEN status='success' THEN 'accepted' ELSE 'preparing' END,auto_checks_scheduled=CASE WHEN status='running' THEN 0 ELSE 1 END;
CREATE INDEX runs_due ON runs(status,next_attempt_at,delivered_at);
CREATE INDEX runs_parent ON runs(parent_id,auto_round,status);
