import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { transformSync } from "esbuild";

// Node's strip-only mode cannot load Workers' parameter properties or sockets.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return nextResolve(
        'data:text/javascript,export function connect(){throw new Error("Unexpected socket")}',
        context,
      );
    }
    if (specifier.startsWith(".") && !/\.[mc]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
      return {
        format: "module",
        shortCircuit: true,
        source: transformSync(readFileSync(fileURLToPath(url), "utf8"), {
          loader: "ts",
          format: "esm",
          target: "es2022",
        }).code,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: app } = await import("../src/access-index.ts");
const { writeSession } = await import("../src/auth.ts");
const { sha256Hex } = await import("../../shared/crypto.ts");
const key = `pwapi_${"x".repeat(40)}`;
const executionContext = { waitUntil() {} };

async function fixture() {
  const accounts = new Map([
    [
      "session-owner",
      {
        id: "session-owner",
        email: "session@example.com",
        password_hash: "a",
        password_salt: "a",
        disabled: 0,
        is_admin: 0,
      },
    ],
    [
      "key-owner",
      {
        id: "key-owner",
        email: "key@example.com",
        password_hash: "b",
        password_salt: "b",
        disabled: 0,
        is_admin: 1,
      },
    ],
  ]);
  const keyHash = await sha256Hex(key);
  const values = new Map();
  const reads = [];
  const constraints = [];
  const writes = [];
  const db = {
    withSession(constraint) {
      constraints.push(constraint);
      return this;
    },
    getBookmark() {
      return "bookmark";
    },
    prepare(sql) {
      return {
        async all() {
          if (sql.startsWith("SELECT area_name, area_type, COUNT(*)")) return { results: [] };
          throw new Error(`Unexpected query: ${sql}`);
        },
        bind(...args) {
          return {
            async first() {
              if (sql === "SELECT * FROM accounts WHERE id = ?")
                return accounts.get(args[0]) ?? null;
              if (sql.startsWith("SELECT id, account_id FROM api_keys")) {
                reads.push("api-key");
                return args[0] === keyHash ? { id: "key-id", account_id: "key-owner" } : null;
              }
              throw new Error(`Unexpected query: ${sql}`);
            },
            async run() {
              if (sql.startsWith("UPDATE accounts SET password_hash")) {
                const account = accounts.get(args[2]);
                if (account) {
                  account.password_hash = args[0];
                  account.password_salt = args[1];
                }
                writes.push(args[2]);
              } else if (
                !sql.startsWith("UPDATE api_keys SET last_used_at") &&
                !sql.startsWith("INSERT INTO worker_errors")
              ) {
                throw new Error(`Unexpected write: ${sql}`);
              }
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
      async get(name) {
        reads.push(name);
        return values.get(name) ?? null;
      },
      async put(name, value) {
        values.set(name, value);
      },
      async delete(name) {
        values.delete(name);
      },
    },
  };
  await writeSession(env, "valid", "session-owner");
  const fetch = (path, options = {}) =>
    app.fetch(new Request(`https://example.com${path}`, options), env, executionContext);
  return { accounts, constraints, fetch, reads, values, writes };
}

function passwordRequest(cookie, additional = {}) {
  return {
    method: "POST",
    headers: {
      Cookie: cookie,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...additional,
    },
    body: JSON.stringify({ newPassword: "a new password" }),
  };
}

test("malformed cookie cannot authorize an API key for a password change", async () => {
  const f = await fixture();
  const response = await f.fetch(
    "/api/set-password",
    passwordRequest("notsession=invalid;\\session=valid"),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(f.writes, []);
});

test("mixed credentials execute only as the validated session owner", async () => {
  const f = await fixture();
  const response = await f.fetch(
    "/api/set-password",
    passwordRequest("notsession=invalid; session=valid"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(f.writes, ["session-owner"]);
  assert.equal(f.accounts.get("key-owner").password_hash, "b");
  assert.equal(f.reads.filter((name) => name === "session:valid").length, 1);
  assert.ok(!f.reads.includes("api-key"));
  assert.deepEqual(f.constraints, ["first-primary"]);
  const me = await f.fetch("/api/me", { headers: { Cookie: "session=valid" } });
  assert.equal((await me.json()).loggedIn, false);
});

test("API keys stay scoped and cannot borrow an expired or invalid session", async () => {
  const f = await fixture();
  for (const cookie of ["", "session=invalid"]) {
    const response = await f.fetch("/api/set-password", passwordRequest(cookie));
    assert.equal(response.status, 403);
  }
  const session = JSON.parse(f.values.get("session:valid"));
  session.authenticatedAt = Date.now() - 16 * 60 * 1000;
  f.values.set("session:valid", JSON.stringify(session));
  const stale = await f.fetch("/api/set-password", passwordRequest("session=valid"));
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).code, "FRESH_AUTH_REQUIRED");
  assert.deepEqual(f.writes, []);
  for (const [method, path] of [
    ["POST", "/api/reauth"],
    ["GET", "/api/letter-intro-presets"],
    ["GET", "/admin/api/accounts"],
  ]) {
    assert.equal(
      (
        await f.fetch(path, {
          method,
          headers: { Authorization: `Bearer ${key}`, Cookie: "session=invalid" },
        })
      ).status,
      403,
    );
  }
  const allowed = await f.fetch("/api/me", {
    headers: { Authorization: `Bearer ${key}`, Cookie: "session=invalid" },
  });
  assert.equal((await allowed.json()).email, "key@example.com");
  const mixed = await f.fetch("/api/me", {
    headers: { Authorization: `Bearer ${key}`, Cookie: "session=valid" },
  });
  assert.equal((await mixed.json()).email, "session@example.com");
});

test("cross-site mutations cannot use a bearer header to bypass session protection", async () => {
  const f = await fixture();
  const response = await f.fetch(
    "/api/set-password",
    passwordRequest("session=valid", {
      Origin: "https://other.example.com",
      "Sec-Fetch-Site": "cross-site",
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(f.writes, []);
});

test("metadata reads authenticate on primary before using a bookmarked replica", async () => {
  const f = await fixture();
  const response = await f.fetch("/api/areas", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.ok(f.reads.includes("api-key"));
  assert.deepEqual(f.constraints, ["first-primary", "bookmark"]);
});
