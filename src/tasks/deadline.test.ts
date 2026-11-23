import assert from "node:assert/strict";
import { test } from "node:test";
import { fromJakartaWallClock } from "../shared/time.ts";
import { classifyDeadlineStage, computeMustFinishBefore } from "./deadline.ts";

test("deadline tanggal 10 finishes before the 10th 00:00 WIB (i.e. 9th 23:59)", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 8, day: 10 });
  assert.equal(mustFinishBefore.getTime(), fromJakartaWallClock(2026, 8, 10, 0, 0, 0, 0).getTime());
  assert.ok(mustFinishBefore.getTime() > fromJakartaWallClock(2026, 8, 9, 23, 59, 59, 999).getTime() - 1);
});

test("H-3 reminder day", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 8, day: 10 }); // last finish day = Aug 9
  const now = fromJakartaWallClock(2026, 8, 6, 8, 0);
  assert.equal(classifyDeadlineStage(now, mustFinishBefore), "h3");
});

test("H-1 reminder day", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 8, day: 10 });
  const now = fromJakartaWallClock(2026, 8, 8, 8, 0);
  assert.equal(classifyDeadlineStage(now, mustFinishBefore), "h1");
});

test("due today at 08:00 on last finish day", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 8, day: 10 });
  const now = fromJakartaWallClock(2026, 8, 9, 8, 0);
  assert.equal(classifyDeadlineStage(now, mustFinishBefore), "due_today");
});

test("due today at 16:00 on last finish day", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 8, day: 10 });
  const now = fromJakartaWallClock(2026, 8, 9, 16, 0);
  assert.equal(classifyDeadlineStage(now, mustFinishBefore), "due_today");
});

test("overdue after 23:59 on last finish day", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 8, day: 10 });
  const now = fromJakartaWallClock(2026, 8, 10, 0, 0, 0, 1);
  assert.equal(classifyDeadlineStage(now, mustFinishBefore), "overdue");
});

test("far from deadline is not flagged", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 8, day: 10 });
  const now = fromJakartaWallClock(2026, 8, 1, 8, 0);
  assert.equal(classifyDeadlineStage(now, mustFinishBefore), "far");
});

test("deadline tanggal 1 rolls back into the previous month", () => {
  const mustFinishBefore = computeMustFinishBefore({ year: 2026, month: 9, day: 1 });
  assert.equal(mustFinishBefore.getTime(), fromJakartaWallClock(2026, 9, 1, 0, 0, 0, 0).getTime());
  const now = fromJakartaWallClock(2026, 8, 31, 12, 0);
  assert.equal(classifyDeadlineStage(now, mustFinishBefore), "due_today");
});
