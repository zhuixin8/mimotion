-- Existing memberships keep their expiry. A preserved membership prevents
-- repeated gifts after profile deletion, repeated login, or concurrent login.
ALTER TABLE site_settings ADD COLUMN new_user_gift_days INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(new_user_gift_days)='integer' AND new_user_gift_days BETWEEN 0 AND 3650);
ALTER TABLE memberships ADD COLUMN registration_gift_days INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER membership_registration_gift AFTER INSERT ON memberships
WHEN NEW.expires_at=0 AND NEW.suspended=0
 AND (SELECT new_user_gift_days FROM site_settings WHERE id=1)>0
BEGIN
 UPDATE memberships SET
  registration_gift_days=(SELECT new_user_gift_days FROM site_settings WHERE id=1),
  expires_at=NEW.created_at+(SELECT new_user_gift_days FROM site_settings WHERE id=1)*86400,
  revision=revision+1
 WHERE account_id=NEW.account_id;
 INSERT INTO admin_audit(id,actor,action,target,details,created_at)
 SELECT lower(hex(randomblob(16))),'system','registration_gift',account_id,
  json_object('days',registration_gift_days,'expires_at',expires_at),NEW.created_at
 FROM memberships WHERE account_id=NEW.account_id;
END;

DROP TRIGGER site_audit;
CREATE TRIGGER site_audit AFTER UPDATE ON site_settings
BEGIN
 INSERT INTO admin_audit(id,actor,action,target,details,created_at)
 VALUES(lower(hex(randomblob(16))),'admin','site_update','site',
  json_object('name',NEW.name,'registration_open',NEW.registration_open,
   'new_user_gift_days',NEW.new_user_gift_days,'revision',NEW.revision),NEW.updated_at);
END;
