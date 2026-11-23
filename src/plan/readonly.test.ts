import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createReadOnlyAuth, createReadOnlySheetsClient, PLAN_READONLY_SCOPE } from "./sheet-source.ts";

const FAKE_KEY = JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: "not-a-real-key" });

test("the plan client asks Google for exactly the readonly scope and nothing else", () => {
  assert.equal(PLAN_READONLY_SCOPE, "https://www.googleapis.com/auth/spreadsheets.readonly");
  const auth = createReadOnlyAuth(FAKE_KEY);
  assert.deepEqual(auth.scopes, ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
});

test("the sheets client is built on that readonly auth", () => {
  const client = createReadOnlySheetsClient(FAKE_KEY) as unknown as { context: { _options: { auth: { scopes: string[] } } } };
  assert.deepEqual(client.context._options.auth.scopes, [PLAN_READONLY_SCOPE]);
});

const planDir = import.meta.dirname;
const sources = readdirSync(planDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: stripComments(readFileSync(join(planDir, name), "utf-8")) }));

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
}

test("src/plan/ never calls a Sheets write method", () => {
  assert.ok(sources.length >= 5, "expected to scan the plan sources");
  const forbidden = /(?<![/\w])(sheets|spreadsheets|values)\s*\.\s*(update|append|batchUpdate|clear|batchClear|batchUpdateByDataFilter|copyTo|create)\b/;
  for (const { name, text } of sources) {
    assert.doesNotMatch(text, forbidden, `${name} calls a Sheets write method`);
  }
});

test("src/plan/ only calls spreadsheets.get and spreadsheets.values.get|batchGet", () => {
  for (const { name, text } of sources) {
    // (?<![/\w]) so the scope URL ".../auth/spreadsheets.readonly" is not mistaken for a call.
    for (const m of text.matchAll(/(?<![/\w])spreadsheets\s*\.\s*([A-Za-z]+)/g)) {
      assert.ok(m[1] === "get" || m[1] === "values", `${name}: spreadsheets.${m[1]} is not allowed`);
    }
    for (const m of text.matchAll(/(?<![/\w])spreadsheets\s*\.\s*values\s*\.\s*([A-Za-z]+)/g)) {
      assert.ok(m[1] === "get" || m[1] === "batchGet", `${name}: spreadsheets.values.${m[1]} is not allowed`);
    }
  }
});

test("src/plan/ imports no write helper from sheets/client.ts or the TASKS export", () => {
  for (const { name, text } of sources) {
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/sheets\/([^"]+)"/g)) {
      const names = (m[1] ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      assert.equal(m[2], "client.ts", `${name} imports from sheets/${m[2]}`);
      assert.deepEqual(names, ["quoteA1SheetName"], `${name} imports a Sheets helper other than quoteA1SheetName`);
    }
    assert.doesNotMatch(text, /createSheetsClient/, `${name} must not build the read-write client`);
  }
});

test("the scan itself catches a write call (so a clean result means something)", () => {
  const forbidden = /(?<![/\w])(sheets|spreadsheets|values)\s*\.\s*(update|append|batchUpdate|clear|batchClear|batchUpdateByDataFilter|copyTo|create)\b/;
  for (const bad of [
    "await sheets.spreadsheets.values.update({})",
    "await sheets.spreadsheets.values.append({})",
    "await sheets.spreadsheets.batchUpdate({})",
    "await sheets.spreadsheets.values.clear({})",
  ]) {
    assert.match(bad, forbidden, bad);
  }
  assert.doesNotMatch("await tx.update(tasks).set({})", forbidden);
});
