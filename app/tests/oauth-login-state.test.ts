import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { transformSync } from "esbuild";

// Node tests use the Worker's real routing; only the unused Workers socket API is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: "data:text/javascript,export function connect() { throw new Error('unexpected socket'); }",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/rate-limiter.ts")) {
      return {
        format: "module",
        source: transformSync(readFileSync(new URL(url), "utf8"), {
          loader: "ts",
          format: "esm",
        }).code,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const { default: app } = await import("../src/access-index.ts");

test("OAuth login binds the callback to the initiating browser and provider", async () => {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const account = {
    id: "account-1",
    email: "user@example.com",
    password_hash: "hash",
    password_salt: "salt",
    disabled: 0,
  };
  const db = {
    withSession() {
      return this;
    },
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async first() {
          if (sql.includes("SELECT account_id FROM oauth_identities"))
            return { account_id: account.id };
          if (sql.includes("SELECT * FROM accounts WHERE id")) return account;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run() {
          return { success: true };
        },
      };
    },
  };
  const env = {
    DB: db,
    SESSIONS: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string, options: { expirationTtl: number }) {
        values.set(key, value);
        ttls.set(key, options.expirationTtl);
      },
      async delete(key: string) {
        values.delete(key);
      },
    },
    OAUTH_GOOGLE_CLIENT_ID: "google-client",
    OAUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    OAUTH_MICROSOFT_CLIENT_ID: "microsoft-client",
    OAUTH_MICROSOFT_CLIENT_SECRET: "microsoft-secret",
  };
  const ctx = { waitUntil() {} };
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  let failExchange = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token" || url.includes("/oauth2/v2.0/token")) {
      exchanges++;
      return Response.json(failExchange ? {} : { access_token: "token" }, {
        status: failExchange ? 400 : 200,
      });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/userinfo")
      return Response.json({ sub: "subject", email: account.email, email_verified: true });
    if (url === "https://graph.microsoft.com/oidc/userinfo")
      return Response.json({ sub: "subject", email: account.email });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const request = (path: string, cookie?: string) =>
    app.fetch(
      new Request(`https://example.com${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
      env as never,
      ctx as never,
    );
  const start = async (provider = "google") => {
    const response = await request(`/api/oauth/${provider}/start`);
    assert.equal(response.status, 302);
    const state = new URL(response.headers.get("Location")!).searchParams.get("state")!;
    const header = response.headers.getSetCookie()[0];
    assert.match(
      header,
      /^__Host-oauth-[A-Za-z0-9]+=[A-Za-z0-9]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/,
    );
    assert.equal(ttls.get(`oauthstate:${state}`), 600);
    return { state, cookie: header.split(";")[0] };
  };
  const callback = (provider: string, state: string, cookie?: string) =>
    request(`/api/oauth/${provider}/callback?code=authorization-code&state=${state}`, cookie);

  try {
    const attacker = await start();
    const victim = await start();
    assert.notEqual(attacker.state, victim.state);
    assert.equal((await callback("google", attacker.state)).status, 400);
    assert.equal((await callback("google", attacker.state, victim.cookie)).status, 400);
    assert.equal(
      (await callback("google", attacker.state, `prefix${attacker.cookie}`)).status,
      400,
    );
    assert.equal((await callback("microsoft", attacker.state, attacker.cookie)).status, 400);
    assert.equal(exchanges, 0);
    assert.ok(values.has(`oauthstate:${attacker.state}`));

    const success = await callback("google", attacker.state, attacker.cookie);
    assert.equal(success.status, 302);
    const cookies = success.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith("session="));
    assert.ok(session);
    assert.ok(
      cookies.some(
        (cookie) =>
          cookie.startsWith(`__Host-oauth-${attacker.state}=;`) && cookie.includes("Max-Age=0"),
      ),
    );
    const token = session.split(";")[0].slice("session=".length);
    assert.equal(JSON.parse(values.get(`session:${token}`)!).accountId, account.id);
    assert.equal((await callback("google", attacker.state, attacker.cookie)).status, 400);
    assert.equal(exchanges, 1);
    assert.equal((await callback("google", victim.state, victim.cookie)).status, 302);
    assert.equal(exchanges, 2);

    const microsoft = await start("microsoft");
    assert.equal((await callback("microsoft", microsoft.state, microsoft.cookie)).status, 302);
    assert.equal(exchanges, 3);
    const expired = await start();
    values.delete(`oauthstate:${expired.state}`);
    assert.equal((await callback("google", expired.state, expired.cookie)).status, 400);
    values.set("oauthstate:oldstate", "1");
    assert.equal(
      (await callback("google", "oldstate", "__Host-oauth-oldstate=anything")).status,
      400,
    );
    assert.equal(exchanges, 3);

    const failing = await start();
    failExchange = true;
    const failure = await callback("google", failing.state, failing.cookie);
    assert.equal(failure.status, 400);
    assert.ok(
      failure.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.startsWith(`__Host-oauth-${failing.state}=;`) && cookie.includes("Max-Age=0"),
        ),
    );
    assert.equal(values.has(`oauthstate:${failing.state}`), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
