import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Workers supplies this module; mail authorization must never open an SMTP socket.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./rate-limiter") {
      return {
        url: "data:text/javascript,export class CredentialRateLimiter {}",
        shortCircuit: true,
      };
    }
    if (specifier === "cloudflare:sockets") {
      return {
        url: 'data:text/javascript,export function connect() { throw new Error("Unexpected SMTP connection") }',
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
const { decryptSecret } = await import("../../shared/crypto.ts");
hooks.deregister();

function fixture() {
  const values = new Map<string, string>();
  const ttl = new Map<string, number>();
  const inserts: unknown[][] = [];
  const accounts = new Map([
    ["account-a", { id: "account-a", password_hash: "a", disabled: 0 }],
    ["account-b", { id: "account-b", password_hash: "b", disabled: 0 }],
  ]);
  const db = {
    withSession: () => db,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => {
              if (sql === "SELECT * FROM accounts WHERE id = ?")
                return accounts.get(String(args[0])) ?? null;
              throw new Error(`Unexpected query: ${sql}`);
            },
            run: async () => {
              if (sql.includes("INSERT INTO mail_credentials")) inserts.push(args);
              else if (!sql.includes("INSERT INTO worker_errors"))
                throw new Error(`Unexpected write: ${sql}`);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    SESSIONS: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string, options: { expirationTtl: number }) => {
        values.set(key, value);
        ttl.set(key, options.expirationTtl);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
    },
    OAUTH_MICROSOFT_CLIENT_ID: "client",
    OAUTH_MICROSOFT_CLIENT_SECRET: "secret",
    MAIL_CRED_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  } as unknown as Parameters<typeof writeSession>[0];
  const request = (path: string, session?: string) =>
    app.fetch(
      new Request(`https://example.com${path}`, {
        headers: session ? { Cookie: `session=${session}` } : {},
      }),
      env,
      {} as ExecutionContext,
    );
  return { env, values, ttl, inserts, accounts, request };
}

async function start(f: ReturnType<typeof fixture>, session: string) {
  const response = await f.request("/api/oauth-mail/microsoft/start", session);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get("Location")!);
  const state = url.searchParams.get("state");
  assert.ok(state);
  assert.equal(f.ttl.get(`oauthmailstate:${state}`), 600);
  return state;
}

function callback(state: string, code = "code") {
  return `/api/oauth-mail/microsoft/callback?${new URLSearchParams({ state, code })}`;
}

test("mail OAuth binds the callback to the initiating account and session before exchanging the code", async () => {
  const f = fixture();
  await writeSession(f.env, "session-a", "account-a");
  await writeSession(f.env, "session-a2", "account-a");
  await writeSession(f.env, "session-b", "account-b");
  const state = await start(f, "session-a");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/token"))
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    if (url === "https://graph.microsoft.com/v1.0/me")
      return Response.json({ mail: "sender@example.com" });
    throw new Error(`Unexpected provider call: ${url}`);
  };
  try {
    assert.equal((await f.request(callback(state), "session-b")).status, 400);
    assert.equal((await f.request(callback(state), "session-a2")).status, 400);
    assert.equal((await f.request(callback(state))).status, 401);
    assert.equal(calls.length, 0);
    assert.equal(f.inserts.length, 0);
    assert.equal((await f.request(callback(state), "session-a")).status, 302);
    assert.equal(calls.length, 2);
    assert.equal(f.inserts.length, 1);
    assert.equal(f.inserts[0][1], "account-a");
    assert.equal(await decryptSecret(f.inserts[0][6] as string, f.env.MAIL_CRED_KEY), "access");
    assert.equal(await decryptSecret(f.inserts[0][7] as string, f.env.MAIL_CRED_KEY), "refresh");
    assert.equal((await f.request(callback(state), "session-a")).status, 400);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mail OAuth rejects missing, expired, legacy and revoked-session state", async () => {
  const f = fixture();
  await writeSession(f.env, "session-a", "account-a");
  const state = await start(f, "session-a");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Unexpected provider call");
  };
  try {
    assert.equal(
      (await f.request("/api/oauth-mail/microsoft/callback?code=code", "session-a")).status,
      400,
    );
    assert.equal(
      (await f.request(`/api/oauth-mail/microsoft/callback?state=${state}`, "session-a")).status,
      400,
    );
    assert.equal((await f.request(callback("unknown"), "session-a")).status, 400);
    f.values.set("oauthmailstate:legacy", "account-a");
    assert.equal((await f.request(callback("legacy"), "session-a")).status, 400);
    f.values.delete(`oauthmailstate:${state}`);
    assert.equal((await f.request(callback(state), "session-a")).status, 400);
    const revoked = await start(f, "session-a");
    f.accounts.get("account-a")!.password_hash = "changed";
    assert.equal((await f.request(callback(revoked), "session-a")).status, 401);
    assert.equal(calls, 0);
    assert.equal(f.inserts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("starting mail OAuth requires a fresh web session", async () => {
  const f = fixture();
  await writeSession(f.env, "old-session", "account-a", Date.now() - 16 * 60 * 1000);
  assert.equal((await f.request("/api/oauth-mail/microsoft/start", "old-session")).status, 403);
  assert.equal((await f.request("/api/oauth-mail/microsoft/start")).status, 403);
});
