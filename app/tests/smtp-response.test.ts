import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Exercise the actual SMTP client with a fake Workers socket in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: "data:text/javascript,export const connect = (...args) => globalThis.smtpTestConnect(...args)",
        shortCircuit: true,
      };
    }
    if (context.parentURL?.endsWith("/shared/smtp.ts") && specifier.startsWith("./"))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { testSmtpAuth } = await import("../../shared/smtp.ts");
const config = {
  host: "smtp.example.com",
  port: 465,
  user: "user@example.com",
  password: "example-password",
  fromAddress: "user@example.com",
};

type Chunk = string | Uint8Array;

function fakeSocket(greeting: Chunk[], replies: Chunk[][] = []) {
  const encoder = new TextEncoder();
  const encode = (chunk: Chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  const writes: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of greeting) c.enqueue(encode(chunk));
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      writes.push(new TextDecoder().decode(bytes));
      for (const chunk of replies.shift() ?? []) controller.enqueue(encode(chunk));
    },
  });
  const socket = {
    readable,
    writable,
    close: async () => {
      closed = true;
      try {
        controller.close();
      } catch {}
    },
  };
  return { socket, writes, isClosed: () => closed };
}

test("fragmented multiline replies wait for CRLF and preserve UTF-8 text", async () => {
  const fake = fakeSocket(
    ["220-hello\r", "\n220 ", "ready\r", "\n"],
    [
      ["250-feature\r\n250 OK\r\n"],
      ["334 VXNlcm5hbWU6\r\n"],
      ["334 UGFzc3dvcmQ6\r\n"],
      ["535 f", new Uint8Array([0xc3]), new Uint8Array([0xa5]), "il\r\n"],
    ],
  );
  globalThis.smtpTestConnect = () => fake.socket;
  await assert.rejects(testSmtpAuth(config), /535 fåil/);
  assert.equal(fake.isClosed(), true);
  assert.equal(fake.writes.at(-1), "ZXhhbXBsZS1wYXNzd29yZA==\r\n");
});

test("valid authentication completes and closes the socket", async () => {
  const fake = fakeSocket(
    ["220 ready\r\n"],
    [["250 OK\r\n"], ["334 user\r\n"], ["334 password\r\n"], ["235 OK\r\n"]],
  );
  globalThis.smtpTestConnect = () => fake.socket;
  await testSmtpAuth(config);
  assert.equal(fake.writes.at(-1), "QUIT\r\n");
  assert.equal(fake.isClosed(), true);
});

test("oversized lines and cumulative multiline replies close the socket", async () => {
  for (const greeting of [
    ["220-" + "a".repeat(4093)],
    ["220-" + "a".repeat(4090), "aaa"],
    ["220-a\r\n".repeat(9363)],
  ]) {
    const fake = fakeSocket(greeting);
    globalThis.smtpTestConnect = () => fake.socket;
    await assert.rejects(testSmtpAuth(config), /svar är för långt/);
    assert.equal(fake.isClosed(), true);
    assert.deepEqual(fake.writes, []);
  }
});

test("a line at the byte limit can be followed by a normal final line", async () => {
  const fake = fakeSocket(
    ["220-" + "a".repeat(4090) + "\r\n220 ready\r\n"],
    [["250 OK\r\n"], ["334 user\r\n"], ["334 password\r\n"], ["235 OK\r\n"]],
  );
  globalThis.smtpTestConnect = () => fake.socket;
  await testSmtpAuth(config);
  assert.equal(fake.isClosed(), true);
});

test("STARTTLS switches sockets before authentication and closes the upgraded socket on failure", async () => {
  const secure = fakeSocket([], [["250 OK\r\n"], ["334 " + "x".repeat(4093)]]);
  const plain = fakeSocket(["220 ready\r\n"], [["250 OK\r\n"], ["220 begin TLS\r\n"]]);
  plain.socket.startTls = () => secure.socket;
  globalThis.smtpTestConnect = () => plain.socket;
  await assert.rejects(testSmtpAuth({ ...config, port: 587 }), /svar är för långt/);
  assert.deepEqual(plain.writes, ["EHLO __PUBLIC_HOST__\r\n", "STARTTLS\r\n"]);
  assert.deepEqual(secure.writes, ["EHLO __PUBLIC_HOST__\r\n", "AUTH LOGIN\r\n"]);
  assert.equal(secure.isClosed(), true);
});

test("an unfinished reply times out and closes the socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSocket(["220 still waiting"]);
  globalThis.smtpTestConnect = () => fake.socket;
  const result = assert.rejects(testSmtpAuth(config), /svarade inte i tid/);
  t.mock.timers.tick(10 * 60 * 1000);
  await result;
  assert.equal(fake.isClosed(), true);
  assert.deepEqual(fake.writes, []);
});
