import assert from "node:assert/strict";
import { test } from "node:test";
import { MeetingMinutesExtractionSchema } from "./minutes-schema.ts";

test("a normal extraction with action items parses", () => {
  const result = MeetingMinutesExtractionSchema.safeParse({
    summary: "Meeting divisi 31 Agustus",
    actionItems: [
      { title: "Wiring panel B", assigneeNames: ["Gunawan"], deadlineText: "tanggal 10" },
      { title: "Beli kabel 12v" },
    ],
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.actionItems.length, 2);
  assert.equal(result.data?.noActionItems, false);
});

test("an informational meeting with no action items must say so explicitly", () => {
  assert.equal(MeetingMinutesExtractionSchema.safeParse({ noActionItems: true }).success, true);
});

// Same rule as ReportExtractionSchema, learned from the 2026-08-12
// regression: a default may cover a field the model FORGOT, never an
// answer it never gave. Silently accepting "no items" from long minutes
// would repeat exactly that failure in a new place.
test("empty actionItems without noActionItems is rejected, not accepted as an empty meeting", () => {
  assert.equal(MeetingMinutesExtractionSchema.safeParse({ actionItems: [] }).success, false);
  assert.equal(MeetingMinutesExtractionSchema.safeParse({}).success, false);
});

test("an action item with no title is rejected — it describes nothing actionable", () => {
  const result = MeetingMinutesExtractionSchema.safeParse({
    actionItems: [{ assigneeNames: ["Gunawan"], deadlineText: "besok" }],
  });
  assert.equal(result.success, false);
});

// The model must hand back raw text for names and dates; the backend
// resolves them (MASTER_SPEC.md §3.6). Keeping these as plain strings is
// what makes that separation enforceable rather than aspirational.
test("assigneeNames and deadlineText stay raw strings, never pre-resolved ids or dates", () => {
  const result = MeetingMinutesExtractionSchema.safeParse({
    actionItems: [{ title: "Wiring", assigneeNames: ["pak Gunawan"], deadlineText: "secepatnya" }],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.data?.actionItems[0]?.assigneeNames, ["pak Gunawan"]);
  assert.equal(result.data?.actionItems[0]?.deadlineText, "secepatnya");
});

test("every optional field may be omitted entirely without losing the item", () => {
  const result = MeetingMinutesExtractionSchema.safeParse({ actionItems: [{ title: "Beli kabel" }] });
  assert.equal(result.success, true);
});

test("an absurdly long action-item list is rejected rather than flooding the task table", () => {
  const tooMany = Array.from({ length: 41 }, (_, i) => ({ title: `Task ${i}` }));
  assert.equal(MeetingMinutesExtractionSchema.safeParse({ actionItems: tooMany }).success, false);
});
