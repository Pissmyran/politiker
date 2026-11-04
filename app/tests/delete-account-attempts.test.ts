import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: "data:text/javascript,export function connect() { throw new Error('unexpected socket'); }",
        shortCircuit: true,
      };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { deleteOwnAccount, login, reauthenticateAccount, writeSession } =
  await import("../src/auth.ts");
const { CredentialRateLimiter } = await import("../src/rate-limiter.ts");
const { hashPassword } = await import("../../shared/crypto.ts");
const secureApp = (await import("../src/secure-index.ts")).default;
const password = "example-password";
const secret = "JBSWY3DPEHPK3PXP";
const { hash, salt } = await hashPassword(password);

async function currentCode(): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array([72, 101, 108, 108, 111, 33, 222, 173, 190, 239]),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)));
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = hmac[19] & 15;
  const value = new DataView(hmac.buffer).getUint32(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}

function fixture() {
  const accounts = new Map<string, Record<string, any>>();
  for (const id of ["one", "two", "password", "oauth"])
    accounts.set(id, {
      id,
      email: `${id}@example.com`,
      password_hash: hash,
      password_salt: salt,
      password_set_by_user: id === "password" ? 1 : 0,
      totp_enabled: id === "oauth" ? 0 : 1,
      totp_secret: secret,
      email_verified: 1,
      disabled: 0,
      is_admin: 0,
    });
  const kv = new Map<string, string>();
  const objects = new Map<
    string,
    { limiter: InstanceType<typeof CredentialRateLimiter>; tail: Promise<unknown> }
  >();
  let unavailable = false;
  const deleted: string[] = [];
  const db = {
    withSession() {
      return db;
    },
    prepare(sql: string) {
      let args: any[] = [];
      return {
        bind(...values: any[]) {
          args = values;
          return this;
        },
        async first() {
          if (sql.includes("WHERE email = ?"))
            return [...accounts.values()].find((a) => a.email === args[0]) ?? null;
          if (sql.includes("WHERE id = ?")) return accounts.get(args[0]) ?? null;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async all() {
          return { results: [] };
        },
      };
    },
    async batch(statements: any[]) {
      deleted.push("batch");
      return statements;
    },
  };
  const env = {
    DB: db,
    SESSIONS: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
    },
    RATE_LIMITER: {
      idFromName(name: string) {
        return name;
      },
      get(id: string) {
        if (!objects.has(id)) {
          const storage = new Map<string, unknown>();
          const state = {
            storage: {
              async get(key: string) {
                return storage.get(key);
              },
              async put(key: string, value: unknown) {
                storage.set(key, value);
              },
            },
          };
          objects.set(id, {
            limiter: new CredentialRateLimiter(state as any),
            tail: Promise.resolve(),
          });
        }
        const object = objects.get(id)!;
        return {
          fetch(_url: string, init: RequestInit) {
            if (unavailable) return Promise.reject(new Error("unavailable"));
            // Durable Object storage input gates serialize each read/modify/write.
            const result = object.tail.then(() =>
              object.limiter.fetch(new Request("https://rate-limiter/acquire", init)),
            );
            object.tail = result.catch(() => {});
            return result;
          },
        };
      },
    },
  } as any;
  return {
    env,
    deleted,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
  };
}

test("concurrent deletion attempts share a limit with login and reauthentication", async () => {
  const { env, deleted } = fixture();
  const calls = Array.from({ length: 20 }, () => deleteOwnAccount(env, "one", password, "invalid"));
  const results = await Promise.allSettled(calls);
  assert.equal(
    results.filter((r) => r.status === "rejected" && /Fel TOTP/.test(String(r.reason))).length,
    10,
  );
  assert.equal(
    results.filter((r) => r.status === "rejected" && /För många försök/.test(String(r.reason)))
      .length,
    10,
  );
  await assert.rejects(reauthenticateAccount(env, "one", password, "invalid"), /För många försök/);
  await assert.rejects(login(env, "one@example.com", password, "invalid"), /För många försök/);
  await assert.rejects(deleteOwnAccount(env, "two", password, "invalid"), /Fel TOTP/);
  assert.equal(deleted.length, 0);
});

test("password attempts and successful factor checks consume the same account limit", async () => {
  const { env, deleted } = fixture();
  await assert.rejects(deleteOwnAccount(env, "password", "wrong", "invalid"), /Fel lösenord/);
  const code = await currentCode();
  await reauthenticateAccount(env, "password", password, code);
  for (let i = 0; i < 8; i++)
    await assert.rejects(deleteOwnAccount(env, "password", password, "invalid"), /Fel TOTP/);
  await assert.rejects(deleteOwnAccount(env, "password", password, code), /För många försök/);
  assert.equal(deleted.length, 0);
});

test("valid factors delete the account, and an unavailable limiter fails closed", async () => {
  const { env, deleted, setUnavailable } = fixture();
  const code = await currentCode();
  setUnavailable(true);
  await assert.rejects(deleteOwnAccount(env, "one", password, code), /För många försök/);
  assert.equal(deleted.length, 0);
  setUnavailable(false);
  await deleteOwnAccount(env, "one", password, code);
  assert.equal(deleted.length, 1);
  await deleteOwnAccount(env, "oauth");
  assert.equal(deleted.length, 2);
});

test("deletion requires a recent ordinary session", async () => {
  const { env, deleted } = fixture();
  await writeSession(env, "old", "oauth", Date.now() - 16 * 60_000);
  const response = await secureApp.fetch(
    new Request("https://example.com/api/delete-account", {
      method: "POST",
      headers: { Cookie: "session=old" },
      body: "{}",
    }),
    env,
    {} as any,
  );
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as any).code, "FRESH_AUTH_REQUIRED");
  assert.equal(deleted.length, 0);
  const anonymous = await secureApp.fetch(
    new Request("https://example.com/api/delete-account", {
      method: "POST",
      body: "{}",
    }),
    env,
    {} as any,
  );
  assert.equal(anonymous.status, 403);
  await writeSession(env, "fresh", "oauth");
  const fresh = await secureApp.fetch(
    new Request("https://example.com/api/delete-account", {
      method: "POST",
      headers: { Cookie: "session=fresh" },
      body: "{}",
    }),
    env,
    {} as any,
  );
  assert.equal(fresh.status, 200);
  assert.equal(deleted.length, 1);
});
