CREATE TABLE site_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 name TEXT NOT NULL DEFAULT 'MiMotion',
 announcement TEXT NOT NULL DEFAULT '',
 contact TEXT NOT NULL DEFAULT '',
 registration_open INTEGER NOT NULL DEFAULT 1 CHECK(registration_open IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL
);
INSERT INTO site_settings(id,updated_at) VALUES(1,unixepoch());
CREATE TABLE user_notes (
 account_id TEXT PRIMARY KEY REFERENCES memberships(account_id),
 note TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL
);
CREATE TABLE issue_reviews (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 stamp TEXT NOT NULL,
 note TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL
);
CREATE TRIGGER site_audit AFTER UPDATE ON site_settings BEGIN
 INSERT INTO admin_audit(id,actor,action,target,details,created_at)
 VALUES(lower(hex(randomblob(16))),'admin','site_update','site',json_object('name',NEW.name,'registration_open',NEW.registration_open,'revision',NEW.revision),NEW.updated_at);
END;
CREATE TRIGGER note_insert_audit AFTER INSERT ON user_notes BEGIN
 INSERT INTO admin_audit(id,actor,action,target,details,created_at)
 VALUES(lower(hex(randomblob(16))),'admin','user_note',NEW.account_id,json_object('revision',NEW.revision),NEW.updated_at);
END;
CREATE TRIGGER note_update_audit AFTER UPDATE ON user_notes BEGIN
 INSERT INTO admin_audit(id,actor,action,target,details,created_at)
 VALUES(lower(hex(randomblob(16))),'admin','user_note',NEW.account_id,json_object('revision',NEW.revision),NEW.updated_at);
END;
CREATE TRIGGER review_insert_audit AFTER INSERT ON issue_reviews BEGIN
 INSERT INTO admin_audit(id,actor,action,target,details,created_at)
 VALUES(lower(hex(randomblob(16))),'admin','issue_review',NEW.run_id,json_object('revision',NEW.revision),NEW.updated_at);
END;
CREATE TRIGGER review_update_audit AFTER UPDATE ON issue_reviews BEGIN
 INSERT INTO admin_audit(id,actor,action,target,details,created_at)
 VALUES(lower(hex(randomblob(16))),'admin','issue_review',NEW.run_id,json_object('revision',NEW.revision),NEW.updated_at);
END;
