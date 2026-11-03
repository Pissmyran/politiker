import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// These tests do not use SMTP or the Durable Object, whose parameter property
// cannot be stripped by Node's TypeScript runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: 'data:text/javascript,export function connect() { throw new Error("Unexpected socket"); }',
        shortCircuit: true,
      };
    }
    if (specifier === "./rate-limiter") {
      return {
        url: "data:text/javascript,export class CredentialRateLimiter {}",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { default: app } = await import("../src/access-index.ts");
const { writeSession } = await import("../src/auth.ts");

async function fixture() {
  const accounts = new Map(
    ["fresh", "older"].map((id) => [
      id,
      {
        id,
        email: `${id}@example.com`,
        password_hash: `${id}-hash`,
        password_salt: "salt",
        totp_enabled: 0,
        totp_secret: null,
        is_admin: 0,
      },
    ]),
  );
  const sessions = new Map<string, string>();
  const writes: string[] = [];
  const db = {
    withSession() {
      return this;
    },
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async first() {
          if (sql === "SELECT * FROM accounts WHERE id = ?")
            return accounts.get(args[0] as string) ?? null;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run() {
          if (sql.startsWith("UPDATE accounts SET password_hash")) {
            const account = accounts.get(args[2] as string)!;
            account.password_hash = args[0] as string;
            account.password_salt = args[1] as string;
            writes.push(account.id);
          } else if (!sql.startsWith("INSERT INTO worker_errors")) {
            throw new Error(`Unexpected update: ${sql}`);
          }
          return { success: true };
        },
      };
    },
  };
  const kv = {
    async get(key: string) {
      return sessions.get(key) ?? null;
    },
    async put(key: string, value: string) {
      sessions.set(key, value);
    },
    async delete(key: string) {
      sessions.delete(key);
    },
  };
  const env = { DB: db, SESSIONS: kv, OAUTH_MICROSOFT_CLIENT_ID: "client" } as any;
  await writeSession(env, "fresh-token", "fresh", Date.now());
  await writeSession(env, "older-token", "older", Date.now() - 16 * 60 * 1000);
  const request = (
    cookie: string,
    headers: Record<string, string> = {},
    path = "/api/set-password",
    method = "POST",
  ) =>
    app.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers: { Cookie: cookie, ...headers },
        ...(method === "POST"
          ? { body: JSON.stringify({ newPassword: "new-password-for-test" }) }
          : {}),
      }),
      env,
      {} as ExecutionContext,
    );
  return { accounts, sessions, writes, kv, request };
}

test("fresh password updates use the exact session cookie, not a suffix match", async () => {
  const f = await fixture();
  const response = await f.request("other_session=older-token; session=fresh-token");
  assert.equal(response.status, 200);
  assert.deepEqual(f.writes, ["fresh"]);
  const revoked = await f.request("session=fresh-token");
  assert.equal(revoked.status, 403);
  assert.deepEqual(f.writes, ["fresh"]);
});

test("stale, missing and API-key-only sessions cannot change passwords", async () => {
  const f = await fixture();
  for (const [cookie, headers, expectedCode] of [
    ["other_session=fresh-token; session=older-token", {}, "FRESH_AUTH_REQUIRED"],
    ["other_session=fresh-token", {}, undefined],
    ["", { Authorization: `Bearer pwapi_${"a".repeat(40)}` }, undefined],
    ["session=older-token; session=fresh-token", {}, "FRESH_AUTH_REQUIRED"],
  ] as const) {
    const response = await f.request(cookie, headers);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: string }).code, expectedCode);
  }
  assert.deepEqual(f.writes, []);
});

test("a session changing between reads cannot change the approved account", async () => {
  const f = await fixture();
  const freshEnvelope = f.sessions.get("session:fresh-token")!;
  const olderEnvelope = f.sessions.get("session:older-token")!;
  let reads = 0;
  f.kv.get = async (key) =>
    key === "session:fresh-token"
      ? ++reads === 1
        ? freshEnvelope
        : olderEnvelope
      : (f.sessions.get(key) ?? null);
  const response = await f.request("session=fresh-token", {
    Authorization: `Bearer pwapi_${"a".repeat(40)}`,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(f.writes, ["fresh"]);
  assert.equal(reads, 1);
});

test("OAuth mail connection start uses the account approved by the freshness gate", async () => {
  const f = await fixture();
  const freshEnvelope = f.sessions.get("session:fresh-token")!;
  const olderEnvelope = f.sessions.get("session:older-token")!;
  let reads = 0;
  f.kv.get = async (key) =>
    key === "session:fresh-token"
      ? ++reads === 1
        ? freshEnvelope
        : olderEnvelope
      : (f.sessions.get(key) ?? null);
  const response = await f.request(
    "other_session=older-token; session=fresh-token",
    {},
    "/api/oauth-mail/microsoft/start",
    "GET",
  );
  assert.equal(response.status, 302);
  assert.equal(reads, 1);
  const state = new URL(response.headers.get("Location")!).searchParams.get("state");
  assert.equal(f.sessions.get(`oauthmailstate:${state}`), "fresh");
});

test("cross-site mutations and rewritten admin routes remain protected", async () => {
  const f = await fixture();
  const crossSite = await f.request("session=fresh-token", { Origin: "https://other.example.com" });
  assert.equal(crossSite.status, 403);
  const admin = await f.request("session=fresh-token", {}, "/admin/api/accounts", "GET");
  assert.equal(admin.status, 403);
  assert.deepEqual(f.writes, []);
});
