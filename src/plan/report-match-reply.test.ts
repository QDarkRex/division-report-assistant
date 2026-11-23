import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReportMatchReply } from "./report-match-reply.ts";

const items = (decisions: Array<[number, "confirm" | "reject"]>, corrections: Array<[number, string]> = []) => ({
  kind: "items" as const,
  decisions: decisions.map(([n, verb]) => ({ n, verb })),
  corrections: corrections.map(([n, planId]) => ({ n, planId })),
});

test("bulk words answer every open question", () => {
  for (const word of ["ya", "Iya", "ok", "betul", "benar", "ya."]) {
    assert.deepEqual(parseReportMatchReply(word), { kind: "bulk", verb: "confirm" }, word);
  }
  for (const word of ["bukan", "tidak", "salah", "Bukan!"]) {
    assert.deepEqual(parseReportMatchReply(word), { kind: "bulk", verb: "reject" }, word);
  }
});

test("'N verb' order", () => {
  assert.deepEqual(parseReportMatchReply("2 ya 3 bukan"), items([[2, "confirm"], [3, "reject"]]));
  assert.deepEqual(parseReportMatchReply("2,3 ya"), items([[2, "confirm"], [3, "confirm"]]));
  assert.deepEqual(parseReportMatchReply("1 bukan"), items([[1, "reject"]]));
  assert.deepEqual(parseReportMatchReply("2 ya, 3 bukan"), items([[2, "confirm"], [3, "reject"]]));
  assert.deepEqual(parseReportMatchReply("2 dan 3 ya"), items([[2, "confirm"], [3, "confirm"]]));
});

test("'verb N' order", () => {
  assert.deepEqual(parseReportMatchReply("ya 2, bukan 3"), items([[2, "confirm"], [3, "reject"]]));
  assert.deepEqual(parseReportMatchReply("bukan 2,3"), items([[2, "reject"], [3, "reject"]]));
  assert.deepEqual(parseReportMatchReply("ya nomor 4"), items([[4, "confirm"]]));
});

test("corrections: '=', 'itu', '->' and '→', also beside verb clauses", () => {
  assert.deepEqual(parseReportMatchReply("3 = 2.08"), items([], [[3, "2.08"]]));
  assert.deepEqual(parseReportMatchReply("3 itu 2.08"), items([], [[3, "2.08"]]));
  assert.deepEqual(parseReportMatchReply("3 -> 2.08"), items([], [[3, "2.08"]]));
  assert.deepEqual(parseReportMatchReply("3 → [2.08]"), items([], [[3, "2.08"]]));
  assert.deepEqual(parseReportMatchReply("2 ya, 3 = 2.08"), items([[2, "confirm"]], [[3, "2.08"]]));
  assert.deepEqual(parseReportMatchReply("3 = 2.08, ya 2"), items([[2, "confirm"]], [[3, "2.08"]]));
});

test("ambiguous input is 'invalid' (help reply), never guessed", () => {
  for (const text of ["2", "2 ya bukan 3", "ya 2 3 bukan", "2 ya 2 bukan", "ya bukan", "2 ya 3", "2.08", "= 2.08", "3 = 2.08 ya", "2 ya, 2 = 2.08"]) {
    assert.deepEqual(parseReportMatchReply(text), { kind: "invalid" }, text);
  }
});

test("anything with an ordinary word is not a reply at all (falls through to normal handling)", () => {
  for (const text of ["tugas Nisa besok apa", "2 orang izin besok", "siapa yang belum lapor", "ya sudah beres kok", "saya lembur jam 5", ""]) {
    assert.equal(parseReportMatchReply(text), null, text);
  }
});
