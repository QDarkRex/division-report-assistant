import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHelperQuery } from "./mention.ts";

test("extracts the text after @helper", () => {
  assert.equal(extractHelperQuery("@helper tugas hari ini apa?"), "tugas hari ini apa?");
});

test("works mid-sentence", () => {
  assert.equal(extractHelperQuery("halo @helper siapa yang belum report?"), "siapa yang belum report?");
});

test("returns null with no @helper mention at all", () => {
  assert.equal(extractHelperQuery("halo semua, ada info penting"), null);
});

// The exact bug class header.ts's own doc comment records twice: a bare
// keyword (no @) matching ordinary chat that merely contains the word.
test("does not match the bare word 'helper' without the @ sigil", () => {
  assert.equal(extractHelperQuery("butuh helper buat angkat barang"), null);
  assert.equal(extractHelperQuery("siapa yang bisa jadi helper minggu ini"), null);
});

test("returns null for a bare mention with nothing after it", () => {
  assert.equal(extractHelperQuery("@helper"), null);
  assert.equal(extractHelperQuery("@helper   "), null);
});

test("is case-insensitive on the mention itself", () => {
  assert.equal(extractHelperQuery("@Helper tugas hari ini apa?"), "tugas hari ini apa?");
});

// Found live 2026-08-12: a member tagged the bot with WhatsApp's mention
// picker and nothing happened. The picker inserts the bot's NUMBER, not
// the word "helper" — this is the exact text WhatsApp actually delivered.
test("a real WhatsApp mention (number in the text, JID in contextInfo) is recognised", () => {
  assert.equal(extractHelperQuery("@62800000000000 saya izin hari ini", true), "saya izin hari ini");
});

test("the mention token is stripped so the LLM never sees a bare number as the request", () => {
  const query = extractHelperQuery("@62800000000000 siapa yang belum lapor?", true);
  assert.ok(!query?.includes("62800000000000"));
  assert.equal(query, "siapa yang belum lapor?");
});

test("a LID-format mention works too — this group addresses participants by LID", () => {
  assert.equal(extractHelperQuery("@10000000000008 saya sakit", true), "saya sakit");
});

test("consecutive leading mentions are all stripped", () => {
  assert.equal(extractHelperQuery("@62800000000000 @111222 tugas hari ini apa?", true), "tugas hari ini apa?");
});

test("a mention of someone ELSE later in the request is preserved as content", () => {
  assert.equal(extractHelperQuery("@62800000000000 pekerjaan @111222 apa?", true), "pekerjaan @111222 apa?");
});

test("a mention with no request after it is not a query", () => {
  assert.equal(extractHelperQuery("@62800000000000", true), null);
});

// The mention flag comes from contextInfo, never from the text: a message
// that merely CONTAINS a number-like @token but doesn't mention the bot
// must stay ignored.
test("a number-like @token without an actual mention of the bot is not a query", () => {
  assert.equal(extractHelperQuery("@62800000000000 saya izin hari ini", false), null);
});

test("typing the literal @helper still works, mention flag or not", () => {
  assert.equal(extractHelperQuery("@helper saya izin", false), "saya izin");
  assert.equal(extractHelperQuery("@helper saya izin", true), "saya izin");
});
