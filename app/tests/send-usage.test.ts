import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// The Worker bundler resolves extensionless imports; use the same resolution in Node tests.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../shared/smtp" && context.parentURL?.endsWith("/send-queue.ts")) {
      return {
        url: "data:text/javascript,export const sendSmtpMail = (...args) => globalThis.testSendMail(...args)",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { countSentToday, countSentTodayForCredential } = await import("../src/db.ts");
const { updateSendJobRate, enqueuePendingUserSendJobs } = await import("../src/send.ts");
const { handleSendQueue } = await import("../src/send-queue.ts");
const { encryptSecret } = await import("../../shared/crypto.ts");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of [
    "0000_current_baseline.sql",
    "0001_drop_legacy_schema_migrations.sql",
    "0002_account_private_contacts.sql",
    "0003_generalize_public_contacts.sql",
    "0004_letter_intro_presets.sql",
    "0005_drop_public_contact_legacy_views.sql",
  ])
    db.exec(readFileSync(new URL(`../../infra/migrations/${file}`, import.meta.url), "utf8"));
  const now = Date.now();
  db.exec(`
    INSERT INTO accounts (id,email,password_hash,password_salt,daily_send_cap,created_at)
      VALUES ('a','a@example.com','','',1,0), ('b','b@example.com','','',1,0);
    INSERT INTO mail_credentials (id,account_id,provider,smtp_host,smtp_port,smtp_user,encrypted_password,from_address,daily_cap,created_at)
      VALUES ('c','a','generic','',25,'','','a@example.com',1,0),
             ('d','a','generic','',25,'','','a@example.com',1,0),
             ('e','b','generic','',25,'','','b@example.com',1,0);
    INSERT INTO letters (id,account_id,html_body,created_at) VALUES ('l','a','text',0),('m','b','text',0);
    INSERT INTO send_jobs (id,account_id,letter_id,mail_credential_id,total_recipients,status,created_at)
      VALUES ('old','a','l','c',1,'done',0), ('other','b','m','e',1,'done',0);
    INSERT INTO send_log VALUES ('success','old','a','one@example.com','ok',NULL,${now}),
      ('bounce','old','a','two@example.com','bounce',NULL,${now}),
      ('yesterday','old','a','three@example.com','ok',NULL,${now - 86400000}),
      ('other-success','other','b','four@example.com','ok',NULL,${now});
  `);
  db.exec(
    readFileSync(new URL("../../infra/migrations/0006_send_usage.sql", import.meta.url), "utf8"),
  );
  const d1 = {
    prepare(sql: string) {
      let params: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) {
          params = values;
          return statement;
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...params) };
        },
        async run() {
          return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, d1: d1 as unknown as D1Database, now };
}

test("deleting a job preserves current-day account and credential usage", async () => {
  const { db, d1 } = fixture();
  const messages: unknown[] = [];
  const env = {
    DB: d1,
    SEND_QUEUE: {
      async send(message: unknown) {
        messages.push(message);
      },
    },
  } as unknown as import("../src/db.ts").Env;
  assert.equal(await countSentToday(d1, "a"), 1);
  assert.equal(await countSentTodayForCredential(d1, "c"), 1);
  assert.equal(await countSentTodayForCredential(d1, "d"), 0);
  await assert.rejects(updateSendJobRate(env, "b", "old", { action: "delete" }));
  await updateSendJobRate(env, "a", "old", { action: "delete" });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM send_log WHERE send_job_id='old'").get()?.n,
    0,
  );
  assert.equal(await countSentToday(d1, "a"), 1);
  assert.equal(await countSentTodayForCredential(d1, "c"), 1);
  assert.equal(await countSentToday(d1, "b"), 1);
  db.exec(`INSERT INTO send_jobs (id,account_id,letter_id,mail_credential_id,total_recipients,status,created_at)
    VALUES ('new','a','l','c',1,'pending',0);
    INSERT INTO send_job_recipients (send_job_id,recipient_email,recipient_name) VALUES ('new','next@example.com','Next');`);
  await enqueuePendingUserSendJobs(env);
  assert.equal(messages.length, 0);
  db.exec("UPDATE mail_credentials SET daily_cap=NULL WHERE id='c'");
  await enqueuePendingUserSendJobs(env);
  assert.equal(messages.length, 0);
  db.close();
});

test("legacy logging, retry attribution, expiry, and account deletion retain the right usage", async () => {
  const { db, d1, now } = fixture();
  db.prepare("INSERT INTO send_log VALUES (?,?,?,?,?,?,?)").run(
    "legacy",
    "old",
    "a",
    "x@example.com",
    "ok",
    null,
    now,
  );
  assert.equal(await countSentTodayForCredential(d1, "c"), 2);
  db.exec("UPDATE send_jobs SET mail_credential_id='d' WHERE id='old'");
  assert.equal(await countSentTodayForCredential(d1, "c"), 2);
  assert.equal(await countSentTodayForCredential(d1, "d"), 0);
  // The new Worker records first; its matching log must not double count.
  db.prepare("INSERT INTO send_usage VALUES (?,?,?,?)").run("new-send", "a", "d", now);
  db.prepare("INSERT INTO send_log VALUES (?,?,?,?,?,?,?)").run(
    "new-send",
    "old",
    "a",
    "y@example.com",
    "ok",
    null,
    now,
  );
  assert.equal(await countSentToday(d1, "a"), 3);
  const tomorrow = Math.floor(now / 86400000) * 86400000 + 86400000;
  db.prepare("INSERT INTO send_usage VALUES (?,?,?,?)").run("tomorrow", "a", "d", tomorrow);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM send_usage WHERE account_id='a'").get()?.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM send_usage WHERE account_id='b'").get()?.n, 1);
  db.exec(
    "DELETE FROM send_log; DELETE FROM send_jobs; DELETE FROM letters; DELETE FROM mail_credentials WHERE account_id='a'; DELETE FROM accounts WHERE id='a'",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM send_usage WHERE account_id='a'").get()?.n, 0);
  db.close();
});

test("a send completing after cancellation and deletion still consumes quota", async () => {
  const { db, d1, now } = fixture();
  const key = btoa("x".repeat(32));
  const password = await encryptSecret("password", key);
  db.prepare("UPDATE mail_credentials SET encrypted_password=? WHERE id='c'").run(password);
  db.exec(`INSERT INTO send_jobs (id,account_id,letter_id,mail_credential_id,total_recipients,status,created_at)
    VALUES ('inflight','a','l','c',1,'sending',0)`);
  db.prepare(
    "INSERT INTO send_job_recipients (send_job_id,recipient_email,recipient_name,status,queued_at) VALUES (?,?,?,?,?)",
  ).run("inflight", "next@example.com", "Next", "queued", now);
  const env = {
    DB: d1,
    MAIL_CRED_KEY: key,
    ATTACHMENTS: {},
    RATE_LIMITER: {
      idFromName: () => "id",
      get: () => ({ fetch: async () => ({ json: async () => ({ granted: true }) }) }),
    },
  } as unknown as import("../src/db.ts").Env;
  db.exec(`INSERT INTO send_jobs (id,account_id,letter_id,mail_credential_id,total_recipients,status,created_at)
    VALUES ('normal','a','l','c',1,'sending',0)`);
  db.prepare(
    "INSERT INTO send_job_recipients (send_job_id,recipient_email,recipient_name,status,queued_at) VALUES (?,?,?,?,?)",
  ).run("normal", "normal@example.com", "Normal", "queued", now);
  (globalThis as typeof globalThis & { testSendMail: () => Promise<void> }).testSendMail =
    async () => {};
  const normalMessage = {
    body: {
      sendJobId: "normal",
      accountId: "a",
      mailCredentialId: "c",
      recipientEmail: "normal@example.com",
      recipientName: "Normal",
      queuedAt: now,
    },
    attempts: 1,
    ack() {},
    retry() {},
  };
  await handleSendQueue(
    { messages: [normalMessage] } as unknown as MessageBatch<
      import("../../shared/types.ts").SendJobMessage
    >,
    env,
  );
  assert.equal(await countSentToday(d1, "a"), 2);
  assert.equal(db.prepare("SELECT status FROM send_jobs WHERE id='normal'").get()?.status, "done");
  await updateSendJobRate(env, "a", "normal", { action: "delete" });
  assert.equal(await countSentTodayForCredential(d1, "c"), 2);
  (globalThis as typeof globalThis & { testSendMail: () => Promise<void> }).testSendMail =
    async () => {
      await updateSendJobRate(env, "a", "inflight", { action: "cancel" });
      await updateSendJobRate(env, "a", "inflight", { action: "delete" });
    };
  const message = {
    body: {
      sendJobId: "inflight",
      accountId: "a",
      mailCredentialId: "c",
      recipientEmail: "next@example.com",
      recipientName: "Next",
      queuedAt: now,
    },
    attempts: 1,
    ack() {},
    retry() {},
  };
  await assert.rejects(
    handleSendQueue(
      { messages: [message] } as unknown as MessageBatch<
        import("../../shared/types.ts").SendJobMessage
      >,
      env,
    ),
  );
  assert.equal(await countSentToday(d1, "a"), 3);
  assert.equal(await countSentTodayForCredential(d1, "c"), 3);
  db.close();
});
