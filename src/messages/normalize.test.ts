import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeIncomingText } from "./normalize.ts";

test("strips invisible direction marks and joiners", () => {
  assert.equal(normalizeIncomingText("\u200eReport\u200f Lembur\u202a Set\u202eiawan\u2060\ufeff\u200b"), "Report Lembur Setiawan");
  assert.equal(normalizeIncomingText("\u200e"), "");
});

test("turns a no-break space into a plain space and leaves ordinary text alone", () => {
  assert.equal(normalizeIncomingText("Report\u00a0Agas"), "Report Agas");
  assert.equal(normalizeIncomingText("Report Agas\n- kerja *tebal* 😀"), "Report Agas\n- kerja *tebal* 😀");
});

test("narrow, figure and thin no-break spaces become plain spaces", () => {
  assert.equal(normalizeIncomingText("cutoff 21\u202fV 5\u2007A 3\u2009mm"), "cutoff 21 V 5 A 3 mm");
});
