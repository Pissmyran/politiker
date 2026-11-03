import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { claimDailySendBudget, hasDailySendBudget } from "../src/send-daily-budget.ts";

const now = Date.UTC(2026, 0, 2, 12);

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, daily_send_cap INTEGER);
    CREATE TABLE mail_credentials (id TEXT PRIMARY KEY, account_id TEXT, daily_cap INTEGER, revoked_at INTEGER);
    CREATE TABLE send_jobs (id TEXT PRIMARY KEY, account_id TEXT, mail_credential_id TEXT, status TEXT,
      daily_limit INTEGER, next_daily_limit INTEGER, limit_switch_at INTEGER);
    CREATE TABLE send_job_recipients (send_job_id TEXT, recipient_email TEXT COLLATE NOCASE, status TEXT, queued_at INTEGER,
      recipient_name TEXT DEFAULT '', subject TEXT, error TEXT);
    CREATE INDEX idx_send_job_recipients_pending ON send_job_recipients(send_job_id, status);
    CREATE TABLE send_log (send_job_id TEXT, account_id TEXT, status TEXT, sent_at INTEGER);
    INSERT INTO accounts VALUES ('a', 2), ('b', 2);
    INSERT INTO mail_credentials VALUES ('c', 'a', 2, NULL), ('d', 'a', NULL, NULL), ('e', 'b', NULL, NULL);
    INSERT INTO send_jobs VALUES ('j1', 'a', 'c', 'pending', NULL, NULL, NULL),
      ('j2', 'a', 'c', 'pending', NULL, NULL, NULL),
      ('j3', 'a', 'd', 'pending', NULL, NULL, NULL),
      ('j4', 'b', 'e', 'pending', NULL, NULL, NULL);
    INSERT INTO send_job_recipients (send_job_id, recipient_email, status, queued_at) VALUES ('j1', 'one@example.com', 'pending', NULL),
      ('j1', 'two@example.com', 'pending', NULL), ('j2', 'three@example.com', 'pending', NULL),
      ('j2', 'four@example.com', 'pending', NULL), ('j3', 'five@example.com', 'pending', NULL),
      ('j4', 'six@example.com', 'pending', NULL);
  `);
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const result = sqlite.prepare(sql).run(...args);
              return { meta: { changes: Number(result.changes) } };
            },
            async first() {
              return sqlite.prepare(sql).get(...args) ?? null;
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...args) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

test("concurrent jobs share credential reservations and release capacity", async () => {
  const { sqlite, db } = fixture();
  const claims = await Promise.all([
    claimDailySendBudget(db, "j1", "a", "c", "one@example.com", now),
    claimDailySendBudget(db, "j1", "a", "c", "two@example.com", now),
    claimDailySendBudget(db, "j2", "a", "c", "three@example.com", now),
    claimDailySendBudget(db, "j2", "a", "c", "four@example.com", now),
  ]);
  assert.equal(claims.filter(Boolean).length, 2);
  sqlite.exec(
    "UPDATE send_job_recipients SET status='pending', queued_at=NULL WHERE recipient_email='one@example.com'",
  );
  assert.equal(await claimDailySendBudget(db, "j2", "a", "c", "three@example.com", now), true);
  assert.equal(await claimDailySendBudget(db, "j4", "b", "e", "six@example.com", now), true);
  assert.equal(await claimDailySendBudget(db, "j3", "b", "e", "five@example.com", now), false);
  sqlite.close();
});

test("enqueue publishes only claimed recipients and releases a failed publication", async () => {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
        return nextResolve(`${specifier}.ts`, context);
      }
    },
  });
  try {
    const { enqueuePendingRecipientsForJob } = await import("../src/send.ts");
    const { sqlite, db } = fixture();
    const published: unknown[] = [];
    const env = {
      DB: db,
      SEND_QUEUE: {
        async send(message: unknown) {
          published.push(message);
        },
      },
    };
    await Promise.all([
      enqueuePendingRecipientsForJob(env, "j1", 2),
      enqueuePendingRecipientsForJob(env, "j2", 2),
    ]);
    assert.equal(published.length, 2);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM send_job_recipients WHERE status='queued'").get().n,
      2,
    );

    sqlite.exec(
      "UPDATE send_job_recipients SET status='pending', queued_at=NULL WHERE send_job_id='j2'",
    );
    const failingEnv = {
      DB: db,
      SEND_QUEUE: {
        async send() {
          throw new Error("publication failed");
        },
      },
    };
    await assert.rejects(enqueuePendingRecipientsForJob(failingEnv, "j2", 2), /publication failed/);
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM send_job_recipients WHERE send_job_id='j2' AND status='queued'",
        )
        .get().n,
      0,
    );
    sqlite.close();
  } finally {
    hooks.deregister();
  }
});

test("fallback account budget includes other credentials, successful sends, and resets at UTC midnight", async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(`INSERT INTO send_log VALUES ('j1', 'a', 'ok', ${now});`);
  assert.equal(await claimDailySendBudget(db, "j1", "a", "c", "one@example.com", now), true);
  assert.equal(await claimDailySendBudget(db, "j3", "a", "d", "five@example.com", now), false);
  sqlite.exec("UPDATE send_job_recipients SET status='ok' WHERE recipient_email='one@example.com'");
  sqlite.exec(`INSERT INTO send_log VALUES ('j1', 'a', 'ok', ${now});`);
  assert.equal(await claimDailySendBudget(db, "j3", "a", "d", "five@example.com", now), false);
  assert.equal(
    await claimDailySendBudget(db, "j3", "a", "d", "five@example.com", now + 86400000),
    true,
  );
  sqlite.close();
});

test("delivery checks current caps, reservation generation, job limits, and existing overbooking", async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(
    `UPDATE send_job_recipients SET status='queued', queued_at=${now} WHERE send_job_id IN ('j1', 'j2');`,
  );
  assert.equal(await hasDailySendBudget(db, "j1", "one@example.com", now, now), true);
  assert.equal(await hasDailySendBudget(db, "j2", "three@example.com", now, now), false);
  assert.equal(await hasDailySendBudget(db, "j1", "one@example.com", now - 1, now), false);
  sqlite.exec("UPDATE send_jobs SET daily_limit=1 WHERE id='j1'");
  assert.equal(await hasDailySendBudget(db, "j1", "two@example.com", now, now), false);
  sqlite.exec("UPDATE mail_credentials SET daily_cap=1 WHERE id='c'");
  assert.equal(await hasDailySendBudget(db, "j1", "two@example.com", now, now), false);
  sqlite.exec("UPDATE send_jobs SET status='cancelled' WHERE id='j1'");
  assert.equal(await hasDailySendBudget(db, "j1", "one@example.com", now, now), false);
  sqlite.close();
});

test("job limit changes are enforced atomically on claims", async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(
    `UPDATE send_jobs SET daily_limit=1, next_daily_limit=2, limit_switch_at=${now + 1000} WHERE id='j1'`,
  );
  assert.equal(await claimDailySendBudget(db, "j1", "a", "c", "one@example.com", now), true);
  assert.equal(await claimDailySendBudget(db, "j1", "a", "c", "two@example.com", now), false);
  assert.equal(await claimDailySendBudget(db, "j1", "a", "c", "two@example.com", now + 1000), true);
  sqlite.close();
});
