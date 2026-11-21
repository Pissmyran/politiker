import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Resolve the extensionless imports used by the Worker bundler in Node's test runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts"))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { updateSendJobRate } = await import("../src/send.ts");
const { enforceLetterRetention } = await import("../src/letter-privacy.ts");

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "0000_current_baseline.sql",
    "0004_letter_intro_presets.sql",
    "0006_letter_retention_queue.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO accounts (id,email,password_hash,password_salt,created_at) VALUES ('owner','owner@example.com','','',0), ('other','other@example.com','','',0);
    INSERT INTO mail_credentials (id,account_id,provider,smtp_host,smtp_port,smtp_user,encrypted_password,from_address,created_at) VALUES ('cred','owner','generic','example.com',587,'','','owner@example.com',0);
    INSERT INTO letters (id,account_id,html_body,created_at) VALUES ('letter','owner','private content',0);
    INSERT INTO letter_attachments (id,letter_id,filename,content_type,r2_key,size_bytes,mode,created_at) VALUES ('attachment','letter','a.txt','text/plain','object-key',1,'attach',0);
    INSERT INTO send_jobs (id,account_id,letter_id,mail_credential_id,total_recipients,status,created_at,finished_at,intro_text) VALUES ('job','owner','letter','cred',1,'done',0,1,'private intro');
    UPDATE send_jobs SET content_delete_at = 9999999999999 WHERE id = 'job';
    INSERT INTO send_job_recipients (send_job_id,recipient_email,recipient_name,status) VALUES ('job','recipient@example.com','Recipient','sent');
    INSERT INTO send_log (id,send_job_id,account_id,recipient_email,status,sent_at) VALUES ('log','job','owner','recipient@example.com','ok',0);
  `);
  let beforeBatch: (() => void) | undefined;
  const db = {
    prepare(sql: string) {
      let params: any[] = [];
      const statement = {
        bind(...values: any[]) {
          params = values;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...params) };
        },
        async run() {
          return { meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } };
        },
      };
      return statement;
    },
    async batch(statements: any[]) {
      beforeBatch?.();
      beforeBatch = undefined;
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const deleted: string[] = [];
  let failStorage = false;
  const env = {
    DB: db,
    ATTACHMENTS: {
      async delete(keys: string[]) {
        if (failStorage) throw new Error("storage unavailable");
        deleted.push(...keys);
      },
    },
  } as any;
  const value = (sql: string) => Object.values(sqlite.prepare(sql).get() ?? {})[0];
  return {
    sqlite,
    env,
    value,
    deleted,
    failStorage: (fail: boolean) => {
      failStorage = fail;
    },
    beforeBatch: (fn: () => void) => {
      beforeBatch = fn;
    },
  };
}

test("deleting history preserves the deadline and retries failed attachment cleanup", async () => {
  const f = fixture();
  await updateSendJobRate(f.env, "owner", "job", { action: "delete" });
  assert.equal(f.value("SELECT COUNT(*) FROM send_jobs"), 0);
  assert.equal(f.value("SELECT COUNT(*) FROM send_log"), 0);
  assert.equal(f.value("SELECT COUNT(*) FROM send_job_recipients"), 0);
  assert.equal(f.value("SELECT content_delete_at FROM letter_retention_queue"), 9999999999999);
  await enforceLetterRetention(f.env);
  assert.equal(f.value("SELECT html_body FROM letters"), "private content");
  assert.deepEqual(f.deleted, []);
  f.sqlite.exec("UPDATE letter_retention_queue SET content_delete_at = 0");
  f.failStorage(true);
  await enforceLetterRetention(f.env);
  assert.equal(f.value("SELECT html_body FROM letters"), "private content");
  assert.equal(f.value("SELECT r2_key FROM letter_attachments"), "object-key");
  assert.equal(f.value("SELECT COUNT(*) FROM letter_retention_queue"), 1);
  f.failStorage(false);
  await enforceLetterRetention(f.env);
  assert.deepEqual(f.deleted, ["object-key"]);
  assert.equal(f.value("SELECT html_body FROM letters"), "redacted:v1");
  assert.equal(f.value("SELECT COUNT(*) FROM letter_attachments"), 0);
  assert.equal(f.value("SELECT COUNT(*) FROM letter_retention_queue"), 0);
});

test("deletion checks ownership and refuses active jobs, including a concurrent retry", async () => {
  const f = fixture();
  await assert.rejects(updateSendJobRate(f.env, "other", "job", { action: "delete" }));
  f.sqlite.exec("UPDATE send_jobs SET status = 'pending' WHERE id = 'job'");
  await assert.rejects(updateSendJobRate(f.env, "owner", "job", { action: "delete" }));
  f.sqlite.exec("UPDATE send_jobs SET status = 'done', finished_at = 1 WHERE id = 'job'");
  f.beforeBatch(() => f.sqlite.exec("UPDATE send_jobs SET status = 'pending' WHERE id = 'job'"));
  await assert.rejects(updateSendJobRate(f.env, "owner", "job", { action: "delete" }));
  assert.equal(f.value("SELECT COUNT(*) FROM letter_retention_queue"), 0);
  assert.equal(f.value("SELECT COUNT(*) FROM send_log"), 1);
  assert.equal(f.value("SELECT status FROM send_jobs"), "pending");
});

test("a failed database batch rolls back the saved deadline and history deletion", async () => {
  const f = fixture();
  f.sqlite.exec(
    "CREATE TRIGGER fail_job_delete BEFORE DELETE ON send_jobs BEGIN SELECT RAISE(ABORT, 'failed'); END;",
  );
  await assert.rejects(updateSendJobRate(f.env, "owner", "job", { action: "delete" }));
  assert.equal(f.value("SELECT COUNT(*) FROM letter_retention_queue"), 0);
  assert.equal(f.value("SELECT COUNT(*) FROM send_log"), 1);
  assert.equal(f.value("SELECT COUNT(*) FROM send_jobs"), 1);
});

test("normal scheduled cleanup and cascading letter deletion remain supported", async () => {
  const f = fixture();
  f.sqlite.exec("UPDATE send_jobs SET content_delete_at = 0 WHERE id = 'job'");
  await enforceLetterRetention(f.env);
  assert.deepEqual(f.deleted, ["object-key"]);
  assert.equal(f.value("SELECT html_body FROM letters"), "redacted:v1");
  assert.equal(f.value("SELECT intro_text FROM send_jobs"), "redacted:v1");
  await updateSendJobRate(f.env, "owner", "job", { action: "delete" });
  f.sqlite.exec("DELETE FROM letters WHERE id = 'letter'");
  assert.equal(f.value("SELECT COUNT(*) FROM letter_retention_queue"), 0);
});

test("missing deadlines are cleaned promptly even when the letter is already redacted", async () => {
  const f = fixture();
  f.sqlite.exec(
    "UPDATE letters SET html_body = 'redacted:v1'; UPDATE send_jobs SET content_delete_at = NULL",
  );
  const before = Date.now();
  await updateSendJobRate(f.env, "owner", "job", { action: "delete" });
  const deadline = f.value("SELECT content_delete_at FROM letter_retention_queue") as number;
  assert.ok(deadline >= before && deadline <= Date.now());
  await enforceLetterRetention(f.env);
  assert.deepEqual(f.deleted, ["object-key"]);
  assert.equal(f.value("SELECT COUNT(*) FROM letter_attachments"), 0);
  assert.equal(f.value("SELECT COUNT(*) FROM letter_retention_queue"), 0);
});
