-- Keep quota usage independent of user-deletable job history.
CREATE TABLE send_usage (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mail_credential_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX idx_send_usage_account_date ON send_usage(account_id, sent_at);
CREATE INDEX idx_send_usage_credential_date ON send_usage(mail_credential_id, sent_at);

-- Existing log rows are attributed as they were by the previous quota query.
INSERT INTO send_usage (id, account_id, mail_credential_id, sent_at)
SELECT l.id, l.account_id, j.mail_credential_id, l.sent_at
FROM send_log l JOIN send_jobs j ON j.id = l.send_job_id
WHERE l.status = 'ok' AND l.sent_at >= unixepoch('now', 'start of day') * 1000;

-- Also account for sends made by an older Worker during the upgrade.
CREATE TRIGGER trg_send_log_usage AFTER INSERT ON send_log
WHEN NEW.status = 'ok'
BEGIN
  INSERT OR IGNORE INTO send_usage (id, account_id, mail_credential_id, sent_at)
  SELECT NEW.id, NEW.account_id, mail_credential_id, NEW.sent_at
  FROM send_jobs WHERE id = NEW.send_job_id;
END;

-- Remove expired usage for an account when it next sends successfully.
CREATE TRIGGER trg_send_usage_expire AFTER INSERT ON send_usage
BEGIN
  DELETE FROM send_usage
  WHERE account_id = NEW.account_id AND sent_at < (NEW.sent_at / 86400000) * 86400000;
END;
