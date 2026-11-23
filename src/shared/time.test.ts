import assert from "node:assert/strict";
import { test } from "node:test";
import { fromJakartaWallClock, mondayOf, reportingDayFor } from "./time.ts";

// Table from docs/division-report-assistant/ACCEPTANCE_TESTS.md §2.1
const cases: Array<{ input: [number, number, number, number, number]; expected: [number, number, number] }> = [
  { input: [2026, 8, 7, 10, 0], expected: [2026, 8, 7] },
  { input: [2026, 8, 7, 9, 59], expected: [2026, 8, 6] },
  { input: [2026, 8, 7, 16, 59], expected: [2026, 8, 7] },
  { input: [2026, 8, 7, 17, 0], expected: [2026, 8, 7] },
  { input: [2026, 8, 7, 23, 59], expected: [2026, 8, 7] },
  { input: [2026, 8, 8, 0, 0], expected: [2026, 8, 7] },
];

for (const { input, expected } of cases) {
  test(`reportingDayFor ${input.join("-")} WIB -> ${expected.join("-")}`, () => {
    const instant = fromJakartaWallClock(...input);
    const day = reportingDayFor(instant);
    assert.deepEqual([day.year, day.month, day.day], expected);
  });
}

// mondayOf must never use Date.getDay() (UTC-based) — the same bug class
// that already corrupted data once in this project.
test("mondayOf on a Sunday returns the Monday that just ended (6 days back)", () => {
  // 2026-08-09 is a Sunday.
  assert.deepEqual(mondayOf({ year: 2026, month: 8, day: 9 }), { year: 2026, month: 8, day: 3 });
});

test("mondayOf on a Monday returns itself", () => {
  // 2026-08-03 is a Monday.
  assert.deepEqual(mondayOf({ year: 2026, month: 8, day: 3 }), { year: 2026, month: 8, day: 3 });
});

test("mondayOf on a Saturday returns the Monday earlier that same week", () => {
  // 2026-08-08 is a Saturday.
  assert.deepEqual(mondayOf({ year: 2026, month: 8, day: 8 }), { year: 2026, month: 8, day: 3 });
});

test("mondayOf handles a week spanning a year boundary", () => {
  // 2027-01-01 is a Friday; that week's Monday is 2026-12-28.
  assert.deepEqual(mondayOf({ year: 2027, month: 1, day: 1 }), { year: 2026, month: 12, day: 28 });
});
