ALTER TABLE runs ADD COLUMN summary_step INTEGER;
ALTER TABLE runs ADD COLUMN detail_step INTEGER;
ALTER TABLE runs ADD COLUMN evidence_state TEXT;
-- Old checks verified summaries only. Preserve the number but remove the claim
-- of detailed consistency; a user can request a fresh read-only verification.
UPDATE runs SET summary_step=observed_step,observed_step=NULL,
  evidence_state='summary_only',verification=CASE WHEN verification='waiting' THEN 'waiting' ELSE 'summary_only' END
  WHERE observed_step IS NOT NULL;
