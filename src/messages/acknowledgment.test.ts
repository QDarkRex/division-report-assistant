import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAcknowledgment } from "./acknowledgment.ts";

test("report_processed names the real sender and lists only the non-zero counts", () => {
  const text = formatAcknowledgment({
    status: "report_processed",
    reportId: "r1",
    summary: { activityCount: 5, taskUpdateCount: 2, taskDoneCount: 1 },
    memberName: "Budi",
    overtime: false,
  });
  assert.equal(text, "✅ *Laporan Budi tercatat*\n5 aktivitas · 2 update task · 1 task selesai");
});

test("report_processed omits zero counts, and says lembur for an overtime report", () => {
  const text = formatAcknowledgment({
    status: "report_processed",
    reportId: "r1",
    summary: { activityCount: 3, taskUpdateCount: 2, taskDoneCount: 0 },
    memberName: "Bagas",
    overtime: true,
  });
  assert.equal(text, "✅ *Laporan lembur Bagas tercatat*\n3 aktivitas · 2 update task");
  assert.doesNotMatch(text ?? "", /candidate|Report\b|\b0 /);
});

// Found live 2026-08-07: the ack hardcoded the literal word "Agas" from
// MASTER_SPEC.md §9.7's example sentence, misattributing every report to
// that name regardless of who actually sent it — §5.2 confirms "Agas" is
// just a generic example name used throughout the doc, not a fixed word.
test("the acknowledgment never hardcodes the example name from the spec", () => {
  const text = formatAcknowledgment({
    status: "report_processed",
    reportId: "r1",
    summary: { activityCount: 1, taskUpdateCount: 0, taskDoneCount: 0 },
    memberName: "Siti",
    overtime: false,
  });
  assert.ok(!text?.includes("Agas"), "ack must use the actual sender's name, not the spec's example name");
  assert.ok(text?.includes("Siti"));
});

test("report_no_activity acknowledges without implying full acceptance, with the real sender's name", () => {
  const text = formatAcknowledgment({ status: "report_no_activity", reportId: "r1", memberName: "Budi" });
  assert.match(text ?? "", /menunggu konfirmasi admin/);
  assert.match(text ?? "", /Budi/);
});

for (const status of ["duplicate", "replayed", "stored_as_context"] as const) {
  test(`${status} produces no reply`, () => {
    assert.equal(formatAcknowledgment({ status }), null);
  });
}

test("an unrecognized sender is silent unless the pipeline flagged a report attempt in the group", () => {
  assert.equal(formatAcknowledgment({ status: "unrecognized_sender", promptRegister: false }), null);
  assert.match(
    formatAcknowledgment({ status: "unrecognized_sender", promptRegister: true }) ?? "",
    /belum terdaftar/,
  );
});

// Found live 2026-08-08: an LLM extraction failure previously left the
// sender with total silence — no ack, no error, nothing.
test("report_extraction_failed tells the sender to resend, by name", () => {
  const text = formatAcknowledgment({ status: "report_extraction_failed", memberName: "Riko", retryable: false });
  assert.match(text ?? "", /Riko/);
  assert.match(text ?? "", /kirim ulang/);
});
