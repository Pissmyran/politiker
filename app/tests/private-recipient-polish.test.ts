import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Script, createContext } from "node:vm";
import { test } from "node:test";
import { assertSourceMatch, assertSourceNoMatch } from "./compact-source.ts";

const source = readFileSync(
  new URL("../public/private-recipient-polish.js", import.meta.url),
  "utf8",
);

function loadParser(): (text: string) => { email: string; name: string }[] {
  const context = createContext({});
  new Script(source).runInContext(context);
  return context.parseContactText as (text: string) => { email: string; name: string }[];
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("extracts CSV, plain and display-name recipient formats", () => {
  const parse = loadParser();
  assert.deepEqual(
    plain(
      parse(
        [
          "Namn,E-post",
          "Anna Andersson,anna@example.com",
          "erik@example.com",
          "Lisa Larsson <lisa@example.com>",
        ].join("\n"),
      ),
    ),
    [
      { email: "anna@example.com", name: "Anna Andersson" },
      { email: "erik@example.com", name: "" },
      { email: "lisa@example.com", name: "Lisa Larsson" },
    ],
  );
});

test("extracts several addresses from the same line and deduplicates them", () => {
  const parse = loadParser();
  assert.deepEqual(plain(parse("anna@example.com; Erik <erik@example.com>; ANNA@example.com")), [
    { email: "anna@example.com", name: "" },
    { email: "erik@example.com", name: "Erik" },
  ]);
});

test("ignores surrounding prose but requires at least one valid address", () => {
  const parse = loadParser();
  assert.deepEqual(plain(parse("Lokala journalister\nKontakta anna@example.com först.")), [
    { email: "anna@example.com", name: "" },
  ]);
  assert.throws(() => parse("Här finns inga adresser"), /inga giltiga e-postadresser/i);
});

test("associates display names once per line and preserves duplicate behavior", () => {
  const parse = loadParser();
  assert.deepEqual(
    plain(
      parse(
        "First <a@example.com>; Second <b@example.com>; Last <A@example.com>, broken <c@example.com",
      ),
    ),
    [
      { email: "a@example.com", name: "Last" },
      { email: "b@example.com", name: "Second" },
      { email: "c@example.com", name: "" },
    ],
  );
  assert.deepEqual(plain(parse("name,alice@example.com")), [
    { email: "alice@example.com", name: "" },
  ]);
});

test("uses the application's CSV splitter and keeps the import limit", () => {
  const context = createContext({});
  new Script(readFileSync(new URL("../public/app-send.js", import.meta.url), "utf8")).runInContext(
    context,
  );
  new Script(source).runInContext(context);
  const parse = context.parseContactText as (text: string) => { email: string; name: string }[];
  assert.deepEqual(plain(parse('"Doe; Jane",jane@example.com')), [
    { email: "jane@example.com", name: "Doe; Jane" },
  ]);
  const addresses = Array.from({ length: 5001 }, (_, i) => `user${i}@example.com`);
  assert.equal(parse(addresses.slice(0, 5000).join("\n")).length, 5000);
  assert.throws(() => parse(addresses.join("\n")), /5 000/);
});

test("handles long malformed imports and input events without blocking", () => {
  const script = `
    const assert = require('node:assert/strict');
    const vm = require('node:vm');
    const source = ${JSON.stringify(source)};
    const listeners = {};
    const input = { value: '', addEventListener: (event, fn) => { listeners[event] = fn; } };
    const button = {};
    const nodes = {
      '#private-recipients': { querySelectorAll: () => [] },
      '#private-import-text': input,
      '#private-import-once': button,
    };
    const context = vm.createContext({
      document: { querySelector: (selector) => nodes[selector] },
      renderPrivateRecipients: () => {},
    });
    vm.runInContext(source, context);
    context.renderPrivateRecipients();
    input.value = '!'.repeat(100000);
    listeners.input();
    assert.equal(button.disabled, true);
    input.value += ' alice@example.com';
    listeners.input();
    assert.equal(button.disabled, false);
    assert.equal(context.parseContactText(input.value)[0].email, 'alice@example.com');
    const names = context.parseContactText('X' + ' '.repeat(100000) + 'Y <a@example.com>');
    assert.equal(names[0].name, 'X Y');
    const many = Array.from({length: 2000}, (_, i) => 'user' + i + '@example.com').join(' ');
    assert.equal(context.parseContactText(many).length, 2000);
    assert.equal(context.parseContactText('A <a@example.com>;' + '< '.repeat(10000) + 'b@example.com')[1].name, '');
  `;
  const result = spawnSync(process.execPath, ["-e", script], { timeout: 5000, encoding: "utf8" });
  assert.equal(result.error?.message, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("clarifies the document import action and gives it a dedicated style hook", () => {
  assertSourceMatch(source, /useFile\.textContent='Använd vald fil som brevtext'/);
  assertSourceMatch(source, /useFile\.classList\.add\('compose-use-file'\)/);
});
