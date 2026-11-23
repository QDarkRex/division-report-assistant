import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { dailyReports } from "../db/schema.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { addRevision } from "../reports/service.ts";
import { describeRepairAction, repairMorningOvertimeCheckins } from "./fix-morning-overtime-checkins-20261009.ts";

const SAT_0917 = new Date("2026-10-03T02:17:00.000Z"); // Saturday 09:17 WIB
const SAT_2100 = new Date("2026-10-03T14:00:00.000Z"); // Saturday 21:00 WIB

async function member(db: Awaited<ReturnType<typeof createTestDb>>, name: string) {
  const m = await createMember(db, { preferredName: name });
  await setMembershipStatus(db, m.memberId, "active");
  return m;
}

async function insertReport(
  db: Awaited<ReturnType<typeof createTestDb>>,
  memberId: string,
  reportingDay: string,
  createdAt: Date,
  extra: { overtimeStartText?: string; overtimeEndText?: string } = {},
) {
  const [row] = await db.insert(dailyReports).values({ memberId, reportingDay, kind: "overtime", createdAt, ...extra }).returning();
  return row!;
}

const rowsOf = (db: Awaited<ReturnType<typeof createTestDb>>, memberId: string) =>
  db.select().from(dailyReports).where(and(eq(dailyReports.memberId, memberId), eq(dailyReports.kind, "overtime")));

test("a misplaced empty morning check-in is MOVED to the calendar day when the member has no report there", async () => {
  const db = await createTestDb();
  const m = await member(db, "Wisnu");
  const misplaced = await insertReport(db, m.memberId, "2026-10-02", SAT_0917, { overtimeStartText: "jam 9" });

  const dry = await repairMorningOvertimeCheckins(db, false);
  assert.equal(dry.length, 1);
  assert.equal(dry[0]?.kind, "move");
  assert.match(describeRepairAction(dry[0]!), /AKAN DIPINDAH.*Wisnu.*2026-10-02 -> 2026-10-03/);
  assert.equal((await rowsOf(db, m.memberId))[0]?.reportingDay, "2026-10-02", "dry run writes nothing");

  const applied = await repairMorningOvertimeCheckins(db, true);
  assert.equal(applied[0]?.kind, "move");
  const rows = await rowsOf(db, m.memberId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.reportId, misplaced.reportId);
  assert.equal(rows[0]?.reportingDay, "2026-10-03");
  assert.equal(rows[0]?.overtimeStartText, "jam 9");

  assert.deepEqual(await repairMorningOvertimeCheckins(db, true), [], "idempotent: nothing left to fix");
});

test("when the member already has Saturday's overtime report: times are copied onto it where empty, and the empty Friday row is deleted", async () => {
  const db = await createTestDb();
  const m = await member(db, "Haryono");
  await insertReport(db, m.memberId, "2026-10-02", SAT_0917, { overtimeStartText: "jam 9", overtimeEndText: "jam 12" });
  const saturday = await insertReport(db, m.memberId, "2026-10-03", SAT_2100, { overtimeEndText: "21:00" });

  const dry = await repairMorningOvertimeCheckins(db, false);
  assert.equal(dry[0]?.kind, "merge_and_delete");
  assert.equal((await rowsOf(db, m.memberId)).length, 2, "dry run deletes nothing");

  await repairMorningOvertimeCheckins(db, true);
  const rows = await rowsOf(db, m.memberId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.reportId, saturday.reportId);
  assert.equal(rows[0]?.reportingDay, "2026-10-03");
  assert.equal(rows[0]?.overtimeStartText, "jam 9", "start copied (it was empty)");
  assert.equal(rows[0]?.overtimeEndText, "21:00", "an existing end time is not overwritten");
});

test("rows that are not misplaced morning check-ins are left alone", async () => {
  const db = await createTestDb();
  const m = await member(db, "Fadlan");
  // evening report on its own reporting day
  await insertReport(db, m.memberId, "2026-10-03", SAT_2100);
  // morning check-in already on the calendar day (post-fix behaviour)
  const m2 = await member(db, "Bagas");
  await insertReport(db, m2.memberId, "2026-10-03", SAT_0917);
  // after-midnight report: 00:30 Saturday filed on Friday is CORRECT (before 05:00)
  const m3 = await member(db, "Arief");
  await insertReport(db, m3.memberId, "2026-10-02", new Date("2026-10-02T17:30:00.000Z"));

  assert.deepEqual(await repairMorningOvertimeCheckins(db, true), []);
  assert.equal((await rowsOf(db, m3.memberId))[0]?.reportingDay, "2026-10-02");
});

test("a misplaced row that has a revision is NOT touched", async () => {
  const db = await createTestDb();
  const m = await member(db, "Wisnu");
  const misplaced = await insertReport(db, m.memberId, "2026-10-02", SAT_0917);
  await addRevision(db, misplaced.reportId, "Report lembur\n- solder");
  await insertReport(db, m.memberId, "2026-10-03", SAT_2100);

  // It has a revision, so it is not a candidate at all: zero revisions is the selector.
  assert.deepEqual(await repairMorningOvertimeCheckins(db, true), []);
  assert.equal((await rowsOf(db, m.memberId)).length, 2);
});
