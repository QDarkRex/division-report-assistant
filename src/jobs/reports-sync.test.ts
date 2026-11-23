import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSyncDays, isQuotaExceededError } from "./reports-sync.ts";

const TODAY = { year: 2026, month: 8, day: 14 };

test("with no bounds, the default rolling window is today and the 7 days before it", () => {
  const days = computeSyncDays(TODAY, null, null);
  assert.equal(days.length, 8);
  assert.deepEqual(days[0], { year: 2026, month: 8, day: 7 });
  assert.deepEqual(days[days.length - 1], TODAY);
});

// Owner request 2026-08-14: pre-create every date tab through end of year.
test("backfillFrom with an explicit future --until walks forward past today, inclusive of both ends", () => {
  const days = computeSyncDays(TODAY, TODAY, { year: 2026, month: 8, day: 17 });
  assert.deepEqual(
    days.map((d) => d.day),
    [14, 15, 16, 17],
  );
});

test("backfillFrom with no --until stops at today, never goes past it", () => {
  const days = computeSyncDays(TODAY, { year: 2026, month: 8, day: 10 }, null);
  assert.deepEqual(
    days.map((d) => d.day),
    [10, 11, 12, 13, 14],
  );
});

test("an --until before --backfill-from is rejected rather than silently producing zero days", () => {
  assert.throws(() => computeSyncDays(TODAY, TODAY, { year: 2026, month: 8, day: 1 }));
});

test("a single-day range (from === until) produces exactly one day", () => {
  const days = computeSyncDays(TODAY, TODAY, TODAY);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0], TODAY);
});

test("a range spanning a year boundary is computed correctly", () => {
  const days = computeSyncDays(TODAY, { year: 2026, month: 12, day: 30 }, { year: 2027, month: 1, day: 2 });
  assert.deepEqual(
    days.map((d) => `${d.year}-${d.month}-${d.day}`),
    ["2026-12-30", "2026-12-31", "2027-1-1", "2027-1-2"],
  );
});

test("a range longer than 400 days throws instead of silently truncating", () => {
  assert.throws(() => computeSyncDays(TODAY, { year: 2020, month: 1, day: 1 }, TODAY));
});

// Found live 2026-08-28: a large backfill hit "Quota exceeded for quota
// metric 'Read requests'/'Write requests' per minute per user" from the
// Sheets API. Only these retry — a malformed row or a permissions error
// would fail identically however many times it's repeated.
test("a Sheets API quota-exceeded error is recognised regardless of read/write wording", () => {
  assert.equal(
    isQuotaExceededError(new Error("Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user' of service 'sheets.googleapis.com'")),
    true,
  );
  assert.equal(
    isQuotaExceededError(new Error("Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user'")),
    true,
  );
});

test("an unrelated error is not treated as retryable", () => {
  assert.equal(isQuotaExceededError(new Error("Requested entity was not found.")), false);
  assert.equal(isQuotaExceededError(new Error("The caller does not have permission")), false);
});

test("a non-Error thrown value is handled without crashing the classifier", () => {
  assert.equal(isQuotaExceededError("Quota exceeded for quota metric"), true);
  assert.equal(isQuotaExceededError({ some: "object" }), false);
});
