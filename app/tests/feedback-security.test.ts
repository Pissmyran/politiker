import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Node cannot load the Workers socket module; feedback uses the mocked HTTP mail transport.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: 'data:text/javascript,export function connect() { throw new Error("unexpected socket") }',
        shortCircuit: true,
      };
    }
    if (specifier === "./rate-limiter") {
      return {
        url: "data:text/javascript,export class CredentialRateLimiter {}",
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const tsUrl = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(tsUrl)) return nextResolve(tsUrl.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { default: app } = await import("../src/access-index.ts");
hooks.deregister();

function fixture() {
  const writes: string[] = [];
  const emails: { html: string }[] = [];
  const db = {
    withSession: () => db,
    prepare(sql: string) {
      return {
        bind() {
          return {
            run: async () => {
              writes.push(sql);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ granted: true }) }),
    },
    RESEND_API_KEY: "test",
    FEEDBACK_NOTIFY_EMAIL: "feedback@example.com",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    emails.push(JSON.parse(init!.body as string));
    return new Response("{}", { status: 200 });
  };
  return {
    writes,
    emails,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    request: (body: BodyInit, headers: HeadersInit = {}) =>
      app.fetch(
        new Request("https://example.com/api/feedback", {
          method: "POST",
          body,
          headers,
          duplex: "half",
        } as RequestInit),
        env as never,
        {} as never,
      ),
  };
}

test("feedback accepts deeply nested compact context and escapes it in mail", async () => {
  const f = fixture();
  try {
    const nested = JSON.parse("[".repeat(1000) + '"<&>"' + "]".repeat(1000));
    const response = await f.request(JSON.stringify({ message: "hello", context: { nested } }));
    assert.equal(response.status, 200);
    assert.equal(f.emails.length, 1);
    assert.ok(
      f.emails[0].html.includes(
        JSON.stringify({ nested })
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;"),
      ),
    );
    assert.equal(f.writes.filter((sql) => sql.startsWith("INSERT INTO feedback")).length, 1);
  } finally {
    f.restore();
  }
});

test("feedback limits the compact context to 12,000 characters", async () => {
  const f = fixture();
  try {
    const accepted = { value: "x".repeat(11988) };
    assert.equal(JSON.stringify(accepted).length, 12000);
    assert.equal(
      (await f.request(JSON.stringify({ message: "hello", context: accepted }))).status,
      200,
    );
    const rejected = { value: "x".repeat(11989) };
    const response = await f.request(JSON.stringify({ message: "hello", context: rejected }));
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "Klientkontexten är för stor",
    );
    assert.equal(f.emails.length, 1);
    assert.equal(f.writes.filter((sql) => sql.startsWith("INSERT INTO feedback")).length, 1);
  } finally {
    f.restore();
  }
});

test("feedback limits actual streamed bytes even with a missing or misleading length", async () => {
  const f = fixture();
  try {
    const valid = JSON.stringify({ message: "hello" });
    const exact = valid + " ".repeat(65536 - valid.length);
    assert.equal((await f.request(exact)).status, 200);
    for (const headers of [{}, { "Content-Length": "1" }]) {
      const data = new TextEncoder().encode(exact + " ");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data.subarray(0, 32000));
          controller.enqueue(data.subarray(32000));
          controller.close();
        },
      });
      assert.equal((await f.request(stream, headers)).status, 413);
    }
    assert.equal(f.emails.length, 1);
    assert.equal(f.writes.filter((sql) => sql.startsWith("INSERT INTO feedback")).length, 1);
  } finally {
    f.restore();
  }
});
