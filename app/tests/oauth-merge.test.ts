import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Worker imports omit extensions; resolve them when running the real code in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return nextResolve("data:text/javascript,export const connect = () => {}", context);
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { handleOAuthCallback, unlinkOAuthIdentity } = await import("../src/oauth.ts");
const { hashPassword, verifyPassword } = await import("../../shared/crypto.ts");
const { login, setPassword } = await import("../src/auth.ts");

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../../infra/migrations/0000_current_baseline.sql", import.meta.url),
      "utf8",
    ),
  );
  let beforeBatch: (() => void) | undefined;
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          const statement = sqlite.prepare(sql);
          return {
            first: async () => statement.get(...params) ?? null,
            all: async () => ({ results: statement.all(...params) }),
            run: async () => statement.run(...params),
          };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      beforeBatch?.();
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, db, onBatch: (fn: () => void) => (beforeBatch = fn) };
}

function providerFetch(emailVerified = true) {
  return async (url: string | URL | Request) => {
    if (String(url).includes("/token")) return Response.json({ access_token: "test-token" });
    return Response.json({
      sub: "provider-user",
      email: "Victim@example.com",
      email_verified: emailVerified,
    });
  };
}

async function setup(verified: boolean) {
  const state = database();
  const password = "attacker-password";
  const { hash, salt } = await hashPassword(password);
  state.sqlite
    .prepare(
      "INSERT INTO accounts (id, email, password_hash, password_salt, password_set_by_user, email_verified, created_at) VALUES (?, ?, ?, ?, 1, ?, 1)",
    )
    .run("account", "victim@example.com", hash, salt, Number(verified));
  const sessions = new Map<string, string>();
  const env = {
    DB: state.db,
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => sessions.set(key, value),
      delete: async (key: string) => sessions.delete(key),
    },
    OAUTH_GOOGLE_CLIENT_ID: "client",
    OAUTH_GOOGLE_CLIENT_SECRET: "secret",
  } as unknown as import("../src/db.ts").Env;
  return { ...state, env, password, hash, salt };
}

test("OAuth reclaim invalidates an unverified signup password atomically", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = providerFetch() as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const { sqlite, env, password, hash } = await setup(false);
  await assert.rejects(login(env, "victim@example.com", password), /inte verifierad/);
  assert.deepEqual(await handleOAuthCallback("google", env, "code"), { accountId: "account" });
  const account = sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get("account") as Record<
    string,
    any
  >;
  assert.equal(account.email_verified, 1);
  assert.equal(account.password_set_by_user, 0);
  assert.notEqual(account.password_hash, hash);
  assert.equal(await verifyPassword(password, account.password_hash, account.password_salt), false);
  await assert.rejects(login(env, "victim@example.com", password), /Fel e-post eller lösenord/);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM oauth_identities").get()?.n, 1);
  await assert.rejects(unlinkOAuthIdentity(env, "account", "google"), /enda inloggningssätt/);
  assert.deepEqual(await handleOAuthCallback("google", env, "code"), { accountId: "account" });
  await setPassword(env, "account", "new-owner-password");
  assert.ok((await login(env, "victim@example.com", "new-owner-password")).sessionToken);
});

test("OAuth preserves a verified account password, including verification concurrent with linking", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = providerFetch() as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  for (const verified of [true, false]) {
    const { sqlite, env, password, hash, salt, onBatch } = await setup(verified);
    if (!verified)
      onBatch(() =>
        sqlite.prepare("UPDATE accounts SET email_verified = 1 WHERE id = ?").run("account"),
      );
    await handleOAuthCallback("google", env, "code");
    const account = sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get("account") as Record<
      string,
      any
    >;
    assert.equal(account.email_verified, 1);
    assert.equal(account.password_set_by_user, 1);
    assert.equal(account.password_hash, hash);
    assert.equal(account.password_salt, salt);
    assert.equal(
      await verifyPassword(password, account.password_hash, account.password_salt),
      true,
    );
  }
});

test("a conflicting identity rolls back the password and verification update", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = providerFetch() as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const { sqlite, env, hash, onBatch } = await setup(false);
  onBatch(() =>
    sqlite
      .prepare(
        "INSERT INTO oauth_identities (id, account_id, provider, provider_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("other", "account", "google", "other-user", 1),
  );
  await assert.rejects(handleOAuthCallback("google", env, "code"), /UNIQUE/);
  const account = sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get("account") as Record<
    string,
    any
  >;
  assert.equal(account.email_verified, 0);
  assert.equal(account.password_hash, hash);
  assert.equal(account.password_set_by_user, 1);
});

test("unverified Google userinfo cannot reclaim an account", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = providerFetch(false) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const { sqlite, env, hash } = await setup(false);
  await assert.rejects(handleOAuthCallback("google", env, "code"), /inte verifierad/);
  const account = sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get("account") as Record<
    string,
    any
  >;
  assert.equal(account.email_verified, 0);
  assert.equal(account.password_hash, hash);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM oauth_identities").get()?.n, 0);
});
