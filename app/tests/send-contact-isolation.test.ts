import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Resolve the Worker's extensionless imports and replace only its socket binding.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: "data:text/javascript,export const connect = (...args) => globalThis.testSmtpConnect(...args)",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { handleSendQueue } = await import("../src/send-queue.ts");
const { getRecipientsForAreas } = await import("../src/db.ts");
const { encryptSecret } = await import("../../shared/crypto.ts");

function database() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../../infra/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          values = args;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
        async run() {
          return sqlite.prepare(sql).run(...values);
        },
      };
    },
  };
  return { db, sqlite };
}

function smtpServer(recipientResponse: string) {
  return () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const respond = (line: string) => controller.enqueue(new TextEncoder().encode(`${line}\r\n`));
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        respond("220 ready");
      },
    });
    let step = 0;
    const responses = [
      "250 hello",
      "334 user",
      "334 password",
      "235 authenticated",
      "250 sender",
      recipientResponse,
      "354 data",
      "250 accepted",
    ];
    const writable = new WritableStream<Uint8Array>({
      write(data) {
        if (new TextDecoder().decode(data).startsWith("QUIT")) return;
        respond(responses[step++]);
      },
    });
    return { readable, writable };
  };
}

test("account SMTP outcomes stay on the job and cannot change shared recipient selection", async () => {
  const { db, sqlite } = database();
  const key = btoa("x".repeat(32));
  const password = await encryptSecret("password", key);
  sqlite.exec(`INSERT INTO accounts (id,email,password_hash,password_salt,created_at) VALUES ('a','a@example.com','x','x',1),('b','b@example.com','x','x',1);
    INSERT INTO letters (id,account_id,html_body,created_at) VALUES ('letter','a','Hello',1);
    INSERT INTO public_contacts (id,name,email,area_name,area_type,last_scraped_at,verification_status,last_verified_at) VALUES
      ('target','Target','target@example.com','Area','eu',1,'unknown',123),
      ('legacy','Legacy','legacy@example.com','Area','eu',1,'dead_via_send',123),
      ('dead','Dead','dead@example.com','Area','eu',1,'dead',123);`);
  sqlite
    .prepare(
      "INSERT INTO mail_credentials (id,account_id,provider,smtp_host,smtp_port,smtp_user,encrypted_password,from_address,created_at) VALUES ('cred','a','generic','smtp.example.com',465,'user',?,'sender@example.com',1)",
    )
    .run(password);
  sqlite.exec(`INSERT INTO send_jobs (id,account_id,letter_id,mail_credential_id,total_recipients,status,created_at) VALUES
      ('job','a','letter','cred',1,'pending',1);
    INSERT INTO send_job_recipients (send_job_id,recipient_email,recipient_name,status,queued_at) VALUES ('job','target@example.com','Target','queued',1);`);
  const env = {
    DB: db,
    MAIL_CRED_KEY: key,
    ATTACHMENTS: { get: async () => null },
    RATE_LIMITER: {
      idFromName: () => "id",
      get: () => ({ fetch: async () => Response.json({ granted: true }) }),
    },
  };
  const message = {
    sendJobId: "job",
    accountId: "a",
    mailCredentialId: "cred",
    recipientEmail: "target@example.com",
    recipientName: "Target",
    queuedAt: 1,
  };
  let acked = false;
  const queueMessage = {
    body: message,
    attempts: 1,
    ack: () => {
      acked = true;
    },
    retry: () => assert.fail("unexpected retry"),
  };
  (globalThis as any).testSmtpConnect = smtpServer("550 5.1.1 User unknown");
  await handleSendQueue({ messages: [queueMessage] } as any, env as any);
  assert.equal(acked, true);
  assert.deepEqual(
    {
      ...sqlite
        .prepare("SELECT status,error FROM send_job_recipients WHERE send_job_id='job'")
        .get(),
    },
    { status: "bounce", error: "RCPT TO nekades (550): 550 5.1.1 User unknown" },
  );
  assert.deepEqual(
    { ...sqlite.prepare("SELECT account_id,status FROM send_log").get() },
    { account_id: "a", status: "bounce" },
  );
  assert.deepEqual(
    {
      ...sqlite
        .prepare(
          "SELECT verification_status,last_verified_at FROM public_contacts WHERE id='target'",
        )
        .get(),
    },
    { verification_status: "unknown", last_verified_at: 123 },
  );
  const area = await getRecipientsForAreas(db as any, ["Area"]);
  const explicit = await getRecipientsForAreas(
    db as any,
    [],
    [],
    [],
    [],
    ["target@example.com", "legacy@example.com", "dead@example.com"],
  );
  for (const recipients of [area, explicit]) {
    assert.deepEqual(recipients.map((r) => r.email).sort(), [
      "legacy@example.com",
      "target@example.com",
    ]);
  }

  // Even a server claiming acceptance cannot replace an independently verified status.
  sqlite.exec(
    "UPDATE public_contacts SET verification_status='dead' WHERE id='target'; UPDATE send_jobs SET status='pending',bounce_count=0,finished_at=NULL WHERE id='job'; UPDATE send_job_recipients SET status='queued',queued_at=1,error=NULL WHERE send_job_id='job'",
  );
  (globalThis as any).testSmtpConnect = smtpServer("250 recipient accepted");
  acked = false;
  await handleSendQueue({ messages: [queueMessage] } as any, env as any);
  assert.equal(acked, true);
  assert.deepEqual(
    {
      ...sqlite
        .prepare("SELECT status,error FROM send_job_recipients WHERE send_job_id='job'")
        .get(),
    },
    { status: "ok", error: null },
  );
  assert.deepEqual(
    {
      ...sqlite
        .prepare(
          "SELECT verification_status,last_verified_at FROM public_contacts WHERE id='target'",
        )
        .get(),
    },
    { verification_status: "dead", last_verified_at: 123 },
  );
  sqlite.close();
});
