// Queued recipients reserve capacity until they are sent or released. The checks
// and the transition must be in the same D1 write, not separate reads.
// CROSS JOIN keeps SQLite's lookup scoped to the account or credential's jobs.
export async function claimDailySendBudget(
  db: D1Database,
  jobId: string,
  accountId: string,
  credentialId: string,
  email: string,
  now: number,
): Promise<boolean> {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const result = await db
    .prepare(
      `UPDATE send_job_recipients SET status = 'queued', queued_at = ?
     WHERE send_job_id = ? AND recipient_email = ? AND status = 'pending'
       AND EXISTS (
         SELECT 1 FROM send_jobs j
         JOIN accounts a ON a.id = j.account_id
         JOIN mail_credentials c ON c.id = j.mail_credential_id AND c.account_id = j.account_id
         WHERE j.id = send_job_recipients.send_job_id AND j.account_id = ?
           AND j.mail_credential_id = ? AND c.revoked_at IS NULL
           AND j.status IN ('pending', 'sending')
           AND (CASE WHEN c.daily_cap IS NULL THEN
                  (SELECT COUNT(*) FROM send_log l WHERE l.account_id = j.account_id AND l.status = 'ok' AND l.sent_at >= ?)
                  + (SELECT COUNT(*) FROM send_jobs qj CROSS JOIN send_job_recipients r ON r.send_job_id = qj.id
                     WHERE qj.account_id = j.account_id AND r.status = 'queued')
                ELSE
                  (SELECT COUNT(*) FROM send_jobs lj JOIN send_log l ON l.send_job_id = lj.id
                   WHERE lj.mail_credential_id = j.mail_credential_id AND l.status = 'ok' AND l.sent_at >= ?)
                  + (SELECT COUNT(*) FROM send_jobs qj CROSS JOIN send_job_recipients r ON r.send_job_id = qj.id
                     WHERE qj.mail_credential_id = j.mail_credential_id AND r.status = 'queued')
                END)
             < COALESCE(c.daily_cap, a.daily_send_cap)
           AND (CASE WHEN j.next_daily_limit IS NOT NULL AND j.limit_switch_at <= ?
                     THEN j.next_daily_limit ELSE j.daily_limit END IS NULL
             OR (SELECT COUNT(*) FROM send_log l WHERE l.send_job_id = j.id AND l.status = 'ok' AND l.sent_at >= ?)
                + (SELECT COUNT(*) FROM send_job_recipients r WHERE r.send_job_id = j.id AND r.status = 'queued')
                < CASE WHEN j.next_daily_limit IS NOT NULL AND j.limit_switch_at <= ?
                       THEN j.next_daily_limit ELSE j.daily_limit END)
       )`,
    )
    .bind(
      now,
      jobId,
      email,
      accountId,
      credentialId,
      day.getTime(),
      day.getTime(),
      now,
      day.getTime(),
      now,
    )
    .run();
  return result.meta.changes === 1;
}

export async function hasDailySendBudget(
  db: D1Database,
  jobId: string,
  email: string,
  queuedAt: number,
  now: number,
): Promise<boolean> {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const row = await db
    .prepare(
      `SELECT 1 AS allowed FROM send_job_recipients target
     JOIN send_jobs j ON j.id = target.send_job_id
     JOIN accounts a ON a.id = j.account_id
     JOIN mail_credentials c ON c.id = j.mail_credential_id AND c.account_id = j.account_id
     WHERE target.send_job_id = ? AND target.recipient_email = ?
       AND target.status = 'queued' AND target.queued_at = ?
       AND j.status IN ('pending', 'sending') AND c.revoked_at IS NULL
       AND (CASE WHEN c.daily_cap IS NULL THEN
              (SELECT COUNT(*) FROM send_log l WHERE l.account_id = j.account_id AND l.status = 'ok' AND l.sent_at >= ?)
              + (SELECT COUNT(*) FROM send_jobs qj CROSS JOIN send_job_recipients r INDEXED BY idx_send_job_recipients_pending ON r.send_job_id = qj.id
                 WHERE qj.account_id = j.account_id AND r.status = 'queued'
                   AND (r.queued_at < target.queued_at OR (r.queued_at = target.queued_at AND r.rowid <= target.rowid)))
            ELSE
              (SELECT COUNT(*) FROM send_jobs lj JOIN send_log l ON l.send_job_id = lj.id
               WHERE lj.mail_credential_id = j.mail_credential_id AND l.status = 'ok' AND l.sent_at >= ?)
              + (SELECT COUNT(*) FROM send_jobs qj CROSS JOIN send_job_recipients r INDEXED BY idx_send_job_recipients_pending ON r.send_job_id = qj.id
                 WHERE qj.mail_credential_id = j.mail_credential_id AND r.status = 'queued'
                   AND (r.queued_at < target.queued_at OR (r.queued_at = target.queued_at AND r.rowid <= target.rowid)))
            END)
         <= COALESCE(c.daily_cap, a.daily_send_cap)
       AND (CASE WHEN j.next_daily_limit IS NOT NULL AND j.limit_switch_at <= ?
                 THEN j.next_daily_limit ELSE j.daily_limit END IS NULL
         OR (SELECT COUNT(*) FROM send_log l WHERE l.send_job_id = j.id AND l.status = 'ok' AND l.sent_at >= ?)
            + (SELECT COUNT(*) FROM send_job_recipients r INDEXED BY idx_send_job_recipients_pending WHERE r.send_job_id = j.id AND r.status = 'queued'
                 AND (r.queued_at < target.queued_at OR (r.queued_at = target.queued_at AND r.rowid <= target.rowid)))
            <= CASE WHEN j.next_daily_limit IS NOT NULL AND j.limit_switch_at <= ?
                    THEN j.next_daily_limit ELSE j.daily_limit END)`,
    )
    .bind(jobId, email, queuedAt, day.getTime(), day.getTime(), now, day.getTime(), now)
    .first();
  return !!row;
}
