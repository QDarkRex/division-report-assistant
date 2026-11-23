import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClarificationRequestSchema,
  ExtractedReportItemSchema,
  MessageClassificationSchema,
  QueryIntentSchema,
  ReportExtractionSchema,
} from "./schemas.ts";

test("a valid message classification parses", () => {
  const result = MessageClassificationSchema.safeParse({ category: "daily_report" });
  assert.equal(result.success, true);
});

test("an unknown category is rejected — the LLM cannot invent a new category", () => {
  const result = MessageClassificationSchema.safeParse({ category: "spam" });
  assert.equal(result.success, false);
});

// ACCEPTANCE_TESTS.md §2.2: "test docking charge" is testing, not done
test("report extraction accepts the testing status distinctly from done", () => {
  const result = ReportExtractionSchema.safeParse({
    noActivity: false,
    items: [{ activity: "test docking charge", result: "charging berhasil", status: "testing" }],
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.items[0]?.status, "testing");
});

test("an invalid report item status is rejected", () => {
  const result = ReportExtractionSchema.safeParse({
    noActivity: false,
    items: [{ activity: "test docking charge", status: "finished" }],
  });
  assert.equal(result.success, false);
});

test("no-activity report needs no items", () => {
  const result = ReportExtractionSchema.safeParse({ noActivity: true, items: [] });
  assert.equal(result.success, true);
});

// d2 (obstacle categorization). Optional+nullable is load-bearing: today's
// live incident (report_extraction_failed) was DeepSeek omitting a
// REQUIRED field and silently dropping a real report. This field must
// never repeat that.
test("an item with a valid obstacleCategory parses", () => {
  const result = ReportExtractionSchema.safeParse({
    noActivity: false,
    items: [{ activity: "cek panel B", status: "blocked", obstacle: "kabel putus", obstacleCategory: "hardware_issue" }],
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.items[0]?.obstacleCategory, "hardware_issue");
});

test("an item omitting obstacleCategory entirely still parses (the whole point of it being optional)", () => {
  const result = ReportExtractionSchema.safeParse({
    noActivity: false,
    items: [{ activity: "cek panel B", status: "in_progress" }],
  });
  assert.equal(result.success, true);
});

test("an invalid obstacleCategory value is rejected, the LLM cannot invent a new category", () => {
  const result = ReportExtractionSchema.safeParse({
    noActivity: false,
    items: [{ activity: "cek panel B", status: "blocked", obstacleCategory: "made_up_category" }],
  });
  assert.equal(result.success, false);
});

test("query intent requires a known intent value", () => {
  assert.equal(QueryIntentSchema.safeParse({ intent: "tasks_today" }).success, true);
  assert.equal(QueryIntentSchema.safeParse({ intent: "make_coffee" }).success, false);
});

test("the three intents added for MASTER_SPEC.md §16's remaining example queries all parse", () => {
  assert.equal(QueryIntentSchema.safeParse({ intent: "member_report", targetMemberName: "Budi", dayOffset: -1 }).success, true);
  assert.equal(QueryIntentSchema.safeParse({ intent: "stale_tasks" }).success, true);
  assert.equal(QueryIntentSchema.safeParse({ intent: "project_summary", projectReference: "Drone VEGA" }).success, true);
});

// dayOffset must never let the model emit a literal date — only a
// bounded integer offset (0 = today), same class of bug already caused
// live data corruption once today (reprocess-message.ts). Range is
// -30..+14 (d3 widened it to allow near-future leave declarations).
test("dayOffset rejects anything that isn't a bounded integer", () => {
  assert.equal(QueryIntentSchema.safeParse({ intent: "member_report", dayOffset: -1 }).success, true);
  assert.equal(QueryIntentSchema.safeParse({ intent: "member_report", dayOffset: "2026-08-07" }).success, false);
  assert.equal(QueryIntentSchema.safeParse({ intent: "member_report", dayOffset: -31 }).success, false);
  assert.equal(QueryIntentSchema.safeParse({ intent: "member_report", dayOffset: 15 }).success, false);
  assert.equal(QueryIntentSchema.safeParse({ intent: "set_availability", dayOffset: 1 }).success, true);
});

test("set_availability requires a known availabilityKind but allows omitting it (ask, don't guess)", () => {
  assert.equal(QueryIntentSchema.safeParse({ intent: "set_availability", availabilityKind: "izin", dayOffset: 0 }).success, true);
  assert.equal(QueryIntentSchema.safeParse({ intent: "set_availability" }).success, true);
  assert.equal(QueryIntentSchema.safeParse({ intent: "set_availability", availabilityKind: "vacation" }).success, false);
});

test("clarification request requires both a question and a reason", () => {
  assert.equal(ClarificationRequestSchema.safeParse({ question: "Deadline tanggal berapa?", reason: "no date found" }).success, true);
  assert.equal(ClarificationRequestSchema.safeParse({ question: "Deadline tanggal berapa?" }).success, false);
});

// A model omitting a field must not lose a report (noActivity 2026-08-08,
// items 2026-08-10), so both fields default. But a default must only stand
// in for a field the model FORGOT — never for an answer it never gave.
// Corrected 2026-08-29 after the defaults silently emptied 26 real reports.
test("a response omitting noActivity still parses when it carries activities", () => {
  const result = ReportExtractionSchema.safeParse({
    items: [{ activity: "cek panel B", status: "in_progress" }],
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.noActivity, false);
});

test("a genuine no-activity report parses with no items at all", () => {
  const result = ReportExtractionSchema.safeParse({ noActivity: true });
  assert.equal(result.success, true);
  assert.deepEqual(result.data?.items, []);
});

// The exact shape deepseek-v4-flash returned for Affan's 2026-08-29 report:
// valid JSON, schema-clean under the old rules, and describing nothing. It
// acknowledged as "0 aktivitas" and rendered in the Sheets date tab as
// "tidak ada aktivitas", making a member who had reported look like he had
// not. It must fail so the bounded repair loop retries instead.
test("an empty items list while noActivity is false is REJECTED, not accepted as an empty report", () => {
  assert.equal(ReportExtractionSchema.safeParse({ noActivity: false, items: [] }).success, false);
});

test("a bare empty object is rejected — no field given at all is not an answer", () => {
  assert.equal(ReportExtractionSchema.safeParse({}).success, false);
});

test("omitting items entirely, with nothing marking it no-activity, is rejected", () => {
  assert.equal(ReportExtractionSchema.safeParse({ noActivity: false }).success, false);
});

test("a wrong-typed items value is still rejected — defaults cover omission, not garbage", () => {
  assert.equal(ReportExtractionSchema.safeParse({ items: "bukan array" }).success, false);
});

test("cancel_availability is a known intent", () => {
  assert.equal(QueryIntentSchema.safeParse({ intent: "cancel_availability", dayOffset: 0 }).success, true);
});

test("an availability reason is optional and capped, so one member cannot fill a spreadsheet cell with an essay", () => {
  assert.equal(QueryIntentSchema.safeParse({ intent: "set_availability", availabilityKind: "izin" }).success, true);
  assert.equal(
    QueryIntentSchema.safeParse({ intent: "set_availability", availabilityKind: "sakit", availabilityReason: "diare" }).success,
    true,
  );
  assert.equal(
    QueryIntentSchema.safeParse({ intent: "set_availability", availabilityKind: "izin", availabilityReason: "x".repeat(201) }).success,
    false,
  );
});

test("matchConfidence and matchReason are optional, and an off-spec confidence degrades instead of failing", () => {
  const base = { activity: "solder", status: "in_progress" } as const;
  assert.equal(ExtractedReportItemSchema.parse(base).matchConfidence, undefined);
  assert.equal(ExtractedReportItemSchema.parse({ ...base, matchConfidence: "high", matchReason: "sama" }).matchConfidence, "high");
  assert.equal(ExtractedReportItemSchema.parse({ ...base, matchConfidence: "medium" }).matchConfidence, undefined);
  assert.equal(ExtractedReportItemSchema.parse({ ...base, matchConfidence: null, matchReason: null }).matchReason, null);
});
