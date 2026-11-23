import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { dailyReports } from "../db/schema.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { getDailyReport, getOrCreateDailyReport } from "../reports/service.ts";
import { formatCalendarDay, overtimeCheckinDayFor, reportingDayFor } from "../shared/time.ts";
import type { QueryIntent } from "../llm/schemas.ts";
import { executeQuery } from "./executors.ts";

// ---------------------------------------------------------------------
// Overtime day attribution, 2026-10-09. Production 2026-10-03 (Saturday):
// five members said "absen lembur"/"mengajukan lembur" at 09:17-09:39 and the
// check-ins landed on FRIDAY's reporting day (reportingDayFor puts anything
// before 10:00 in the previous day), creating five empty overtime reports on
// the wrong day. A 05:00-09:59 check-in now means working TODAY.
// ---------------------------------------------------------------------

function intent(overrides: Partial<QueryIntent>): QueryIntent {
  return { intent: "unknown", ...overrides } as QueryIntent;
}

async function activeMember(db: Awaited<ReturnType<typeof createTestDb>>, name = "Agas") {
  const m = await createMember(db, { preferredName: name });
  await setMembershipStatus(db, m.memberId, "active");
  return m;
}

const SAT_0459 = new Date("2026-10-02T21:59:00.000Z"); // Saturday 04:59 WIB
const SAT_0501 = new Date("2026-10-02T22:01:00.000Z"); // Saturday 05:01 WIB
const SAT_0917 = new Date("2026-10-03T02:17:00.000Z"); // Saturday 09:17 WIB
const SAT_0959 = new Date("2026-10-03T02:59:00.000Z"); // Saturday 09:59 WIB
const SAT_1001 = new Date("2026-10-03T03:01:00.000Z"); // Saturday 10:01 WIB
const SAT_2000 = new Date("2026-10-03T13:00:00.000Z"); // Saturday 20:00 WIB

test("overtimeCheckinDayFor: 05:00-09:59 is the calendar day, everything else the reporting day", () => {
  const label = (d: Date) => formatCalendarDay(overtimeCheckinDayFor(d));
  assert.equal(label(SAT_0459), "2026-10-02", "04:59 continues Friday evening");
  assert.equal(label(SAT_0501), "2026-10-03");
  assert.equal(label(SAT_0917), "2026-10-03");
  assert.equal(label(SAT_0959), "2026-10-03");
  assert.equal(label(SAT_1001), "2026-10-03");
  assert.equal(label(SAT_2000), "2026-10-03");
  assert.equal(label(new Date("2026-10-03T16:59:00.000Z")), "2026-10-03", "23:59 Saturday");
  assert.equal(label(new Date("2026-10-03T17:30:00.000Z")), "2026-10-03", "00:30 Sunday is still Saturday's evening");
});

test("a morning check-in lands on the calendar day, not the previous reporting day", async () => {
  const db = await createTestDb();
  const m = await activeMember(db);

  const result = await executeQuery(db, intent({ intent: "overtime_checkin" }), SAT_0917, m.memberId);
  assert.equal(result.kind, "overtime_checked_in");
  if (result.kind === "overtime_checked_in") assert.equal(result.day, "2026-10-03");
  assert.ok(await getDailyReport(db, m.memberId, "2026-10-03", "overtime"), "Saturday's overtime report exists");
  assert.equal(await getDailyReport(db, m.memberId, "2026-10-02", "overtime"), null, "and nothing was created on Friday");
});

test("after-midnight and evening check-ins keep the reporting day", async () => {
  const db = await createTestDb();
  const cases: Array<[Date, string]> = [
    [SAT_0459, "2026-10-02"],
    [SAT_1001, "2026-10-03"],
    [SAT_2000, "2026-10-03"],
    [new Date("2026-10-03T17:30:00.000Z"), "2026-10-03"],
  ];
  for (const [at, expectedDay] of cases) {
    const m = await activeMember(db, `M${at.getTime()}`);
    const result = await executeQuery(db, intent({ intent: "overtime_checkin" }), at, m.memberId);
    assert.equal(result.kind, "overtime_checked_in");
    if (result.kind === "overtime_checked_in") assert.equal(result.day, expectedDay, at.toISOString());
  }
});

test("a morning check-in and the evening 'Report lembur' of the same Saturday share one overtime report", async () => {
  const db = await createTestDb();
  const m = await activeMember(db);
  await executeQuery(db, intent({ intent: "overtime_checkin", timeText: "jam 9" }), SAT_0917, m.memberId);
  const morning = await getDailyReport(db, m.memberId, "2026-10-03", "overtime");
  assert.ok(morning);

  // The evening report path: reportingDayFor(20:00 Saturday) = Saturday, and
  // getOrCreateDailyReport reuses the row that the check-in opened.
  const evening = await getOrCreateDailyReport(db, m.memberId, formatCalendarDay(reportingDayFor(SAT_2000)), "overtime");
  assert.equal(evening.reportId, morning.reportId, "one report, not two");
  assert.equal(evening.overtimeStartText, "jam 9", "and it still carries the morning start time");
});

test("a checkout attaches to the member's open overtime report from the last 18 hours", async () => {
  const db = await createTestDb();
  const m = await activeMember(db);
  // Morning check-in on Saturday; the member stops at 09:50 the same morning,
  // when reportingDayFor alone would say Friday.
  await executeQuery(db, intent({ intent: "overtime_checkin" }), SAT_0917, m.memberId);
  const stop = new Date("2026-10-03T02:50:00.000Z"); // 09:50 WIB
  const result = await executeQuery(db, intent({ intent: "overtime_checkout", timeText: "jam 9" }), stop, m.memberId);
  assert.equal(result.kind, "overtime_checked_out");
  if (result.kind === "overtime_checked_out") assert.equal(result.day, "2026-10-03");
  assert.equal((await getDailyReport(db, m.memberId, "2026-10-03", "overtime"))?.overtimeEndText, "jam 9");
  assert.equal(await getDailyReport(db, m.memberId, "2026-10-02", "overtime"), null);
});

test("a checkout after midnight lands on the evening's report", async () => {
  const db = await createTestDb();
  const m = await activeMember(db);
  const fridayEvening = new Date("2026-10-02T13:00:00.000Z"); // Friday 20:00 WIB
  await executeQuery(db, intent({ intent: "overtime_checkin" }), fridayEvening, m.memberId);
  const stop = new Date("2026-10-02T17:30:00.000Z"); // Saturday 00:30 WIB
  const result = await executeQuery(db, intent({ intent: "overtime_checkout", timeText: "00:30" }), stop, m.memberId);
  if (result.kind === "overtime_checked_out") assert.equal(result.day, "2026-10-02");
  assert.equal((await getDailyReport(db, m.memberId, "2026-10-02", "overtime"))?.overtimeEndText, "00:30");
});

test("a checkout does not attach to a report older than 18 hours", async () => {
  const db = await createTestDb();
  const m = await activeMember(db);
  const old = new Date("2026-10-01T10:00:00.000Z"); // Thursday 17:00 WIB, 40+ hours before the checkout
  await db.insert(dailyReports).values({ memberId: m.memberId, reportingDay: "2026-10-01", kind: "overtime", createdAt: old });

  const result = await executeQuery(db, intent({ intent: "overtime_checkout", timeText: "21:00" }), SAT_2000, m.memberId);
  if (result.kind === "overtime_checked_out") assert.equal(result.day, "2026-10-03", "falls back to the reporting day");
  assert.equal((await getDailyReport(db, m.memberId, "2026-10-01", "overtime"))?.overtimeEndText, null, "the stale report was not touched");
  assert.equal((await getDailyReport(db, m.memberId, "2026-10-03", "overtime"))?.overtimeEndText, "21:00");
});

test("a checkout does not overwrite a report that is already closed", async () => {
  const db = await createTestDb();
  const m = await activeMember(db);
  await executeQuery(db, intent({ intent: "overtime_checkin" }), SAT_2000, m.memberId);
  await executeQuery(db, intent({ intent: "overtime_checkout", timeText: "21:00" }), SAT_2000, m.memberId);
  const closed = await getDailyReport(db, m.memberId, "2026-10-03", "overtime");
  assert.equal(closed?.overtimeEndText, "21:00");

  // The closed report is no longer "open": the second stop goes through the fallback (same reporting day row) and updates it.
  await executeQuery(db, intent({ intent: "overtime_checkout", timeText: "22:00" }), SAT_2000, m.memberId);
  assert.equal((await getDailyReport(db, m.memberId, "2026-10-03", "overtime"))?.overtimeEndText, "22:00");
});

test("'siapa yang lembur' in the morning lists the people who checked in this morning", async () => {
  const db = await createTestDb();
  const m = await activeMember(db, "Arief");
  await executeQuery(db, intent({ intent: "overtime_checkin" }), SAT_0917, m.memberId);
  const list = await executeQuery(db, intent({ intent: "overtime_today" }), new Date("2026-10-03T02:30:00.000Z"), m.memberId);
  assert.equal(list.kind, "overtime_today");
  if (list.kind === "overtime_today") {
    assert.equal(list.day, "2026-10-03");
    assert.deepEqual(list.reporters.map((r) => r.preferredName), ["Arief"]);
  }
});
