import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { members, taskEvents, taskObstacles } from "../db/schema.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { createProject, confirmProject } from "../projects/service.ts";
import { createTask, transitionStatus, recordObstacle } from "../tasks/service.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { buildWeeklySummary, formatWeeklySummaryText } from "./weekly-summary.ts";
import { setAvailability } from "../members/availability.ts";
import type { Task } from "../tasks/types.ts";

// Wednesday of the week 2026-08-03..2026-08-09 (Monday..Sunday).
const MID_WEEK = new Date("2026-08-05T05:00:00.000Z"); // 12:00 WIB Wed

test("weekStart resolves to the Monday of the current reporting week", async () => {
  const db = await createTestDb();
  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.weekStart, "2026-08-03");
});

test("a task completed within the week window counts as completedThisWeek", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work");
  await transitionStatus(db, task.taskId, "member_marks_done");
  // transitionStatus stamps createdAt with the real wall clock, not
  // MID_WEEK — backdate so this test doesn't silently start failing once
  // real "now" drifts outside 2026-08-03..2026-08-09 (found live 2026-08-10).
  await db.update(taskEvents).set({ createdAt: MID_WEEK }).where(eq(taskEvents.taskId, task.taskId));

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.completedThisWeek.length, 1);
  assert.equal(summary.completedThisWeek[0]?.title, "Cek panel B");
});

test("open task counts are broken down by status", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const t1 = await createTask(db, { title: "Task A", createdByMemberId: admin.memberId });
  const t2 = await createTask(db, { title: "Task B", createdByMemberId: admin.memberId });
  await transitionStatus(db, t2.taskId, "member_reports_work");
  void t1;

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.openCounts.active, 1);
  assert.equal(summary.openCounts.inProgress, 1);
});

test("obstacles raised within the week window are counted", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });
  await recordObstacle(db, task.taskId, "menunggu part", admin.memberId);
  // Same real-clock-vs-fictional-week issue as the completedThisWeek test above.
  await db.update(taskObstacles).set({ createdAt: MID_WEEK }).where(eq(taskObstacles.taskId, task.taskId));

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.obstaclesRaisedCount, 1);
});

test("report compliance counts distinct reporting days per active member within the week", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await getOrCreateDailyReport(db, member.memberId, "2026-08-03");
  await getOrCreateDailyReport(db, member.memberId, "2026-08-04");
  await getOrCreateDailyReport(db, member.memberId, "2026-07-27"); // previous week, must not count

  const summary = await buildWeeklySummary(db, MID_WEEK);
  const budi = summary.reportCompliance.find((r) => r.memberName === "Budi");
  assert.equal(budi?.reportedDays, 2);
  assert.equal(budi?.requiredDays, 6);
});

test("a member not required to report is excluded from compliance", async () => {
  const db = await createTestDb();
  await createMember(db, { preferredName: "Budi", reportRequired: false }).then((m) => setMembershipStatus(db, m.memberId, "active"));

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.reportCompliance.find((r) => r.memberName === "Budi"), undefined);
});

test("projectsTouched lists distinct project names among this week's completed/open tasks", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const project = await createProject(db, { name: "Drone VEGA" });
  await confirmProject(db, project.projectId);
  await createTask(db, { title: "Task A", createdByMemberId: admin.memberId, projectId: project.projectId });

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.deepEqual(summary.projectsTouched, ["Drone VEGA"]);
});

// d2 (obstacle categorization)
test("topObstacleCategories aggregates within the week window, sorted by count, excluding 'none'", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-04");
  const revision = await addRevision(db, report.reportId, "report\n- a\n- b\n- c\n- d");
  await addReportItem(db, revision.revisionId, { activity: "a", status: "blocked", obstacleCategory: "hardware_issue" });
  await addReportItem(db, revision.revisionId, { activity: "b", status: "blocked", obstacleCategory: "hardware_issue" });
  await addReportItem(db, revision.revisionId, { activity: "c", status: "blocked", obstacleCategory: "waiting_material" });
  await addReportItem(db, revision.revisionId, { activity: "d", status: "done", obstacleCategory: "none" });

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.deepEqual(summary.topObstacleCategories, [
    { category: "hardware_issue", count: 2 },
    { category: "waiting_material", count: 1 },
  ]);
});

test("topObstacleCategories excludes items from outside the week window", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-07-27"); // previous week
  const revision = await addRevision(db, report.reportId, "report\n- a", undefined);
  await addReportItem(db, revision.revisionId, { activity: "a", status: "blocked", obstacleCategory: "hardware_issue" });

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.deepEqual(summary.topObstacleCategories, []);
});

// Windowed by dailyReports.reportingDay, not reportItems.createdAt — a
// row inserted "now" (real wall-clock time, long after 2026-08-05) still
// counts because the report it belongs to is ABOUT a day inside the week.
test("topObstacleCategories counts a report attributed to a day inside the week regardless of when the row was actually inserted", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-04"); // inside the MID_WEEK window
  const revision = await addRevision(db, report.reportId, "report\n- a"); // createdAt defaults to real "now", not 2026
  await addReportItem(db, revision.revisionId, { activity: "a", status: "blocked", obstacleCategory: "software_issue" });

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.deepEqual(summary.topObstacleCategories, [{ category: "software_issue", count: 1 }]);
});

// Fixed 2026-08-12: requiredDays was a flat 6 for everyone, so a member on
// three days' approved cuti read as "3/6" — visually identical to someone
// who ignored the bot for half the week.
test("declared leave days are subtracted from requiredDays, not counted as non-compliance", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  // Week is 2026-08-03..2026-08-08 (Mon..Sat). Reported Mon-Wed, cuti Thu-Sat.
  for (const day of ["2026-08-03", "2026-08-04", "2026-08-05"]) {
    await getOrCreateDailyReport(db, member.memberId, day);
  }
  for (const day of [6, 7, 8]) {
    await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day });
  }

  const summary = await buildWeeklySummary(db, MID_WEEK);
  const budi = summary.reportCompliance.find((r) => r.memberName === "Budi");
  assert.equal(budi?.reportedDays, 3);
  assert.equal(budi?.requiredDays, 3, "6 work days minus 3 declared leave days");
  assert.equal(budi?.leaveDays, 3);
});

test("a fully-compliant member on leave is not listed as behind in the rendered text", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  for (const day of ["2026-08-03", "2026-08-04", "2026-08-05"]) {
    await getOrCreateDailyReport(db, member.memberId, day);
  }
  for (const day of [6, 7, 8]) {
    await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day });
  }

  const text = formatWeeklySummaryText(await buildWeeklySummary(db, MID_WEEK));
  assert.ok(!text.includes("Kepatuhan lapor"), "3/3 is compliant — nothing to flag");
});

test("requiredDays never goes negative even if leave covers more days than the work week", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  for (let day = 3; day <= 9; day++) {
    await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day });
  }

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.reportCompliance.find((r) => r.memberName === "Budi")?.requiredDays, 0);
});

// Owner 2026-08-29: Saturday is only owed by magang, so a flat 6-day
// requirement would score every senior and staff member one day short
// every single week — the same misrepresentation the leave subtraction
// exists to prevent.
test("a non-magang owes 5 days, not 6 — Saturday is not theirs", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.reportCompliance.find((r) => r.memberName === "Affan")?.requiredDays, 5);
});

test("a magang still owes all 6 days", async () => {
  const db = await createTestDb();
  const magang = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, magang.memberId, "active");

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.reportCompliance.find((r) => r.memberName === "Budi")?.requiredDays, 6);
});

test("a non-magang who declared 'masuk' for that Saturday owes 6 again", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));
  // MID_WEEK's week is 2026-08-03..09; its Saturday is 2026-08-08.
  await setAvailability(db, senior.memberId, "masuk", { year: 2026, month: 8, day: 8 });

  const summary = await buildWeeklySummary(db, MID_WEEK);
  assert.equal(summary.reportCompliance.find((r) => r.memberName === "Affan")?.requiredDays, 6);
});

test("leave still subtracts on top of the Saturday exemption, never going negative", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));
  for (const day of [3, 4, 5, 6, 7]) {
    await setAvailability(db, senior.memberId, "cuti", { year: 2026, month: 8, day });
  }

  const summary = await buildWeeklySummary(db, MID_WEEK);
  const affan = summary.reportCompliance.find((r) => r.memberName === "Affan");
  assert.equal(affan?.requiredDays, 0, "5 owed days minus 5 leave days");
  assert.equal(affan?.leaveDays, 5);
});

test("the weekly text is titled, counted in Indonesian, and labels dates and categories", () => {
  const text = formatWeeklySummaryText({
    weekStart: "2026-08-03",
    completedThisWeek: [{ title: "a" }, { title: "b" }, { title: "c" }] as Task[],
    openCounts: { active: 4, inProgress: 12, blocked: 3, stale: 0, paused: 0 },
    stillOverdue: [{ title: "Gimbal: kalibrasi", sourceReference: "master-plan-aerolift:G4" }, { title: "Solder PCB", sourceReference: null }] as Task[],
    obstaclesRaisedCount: 2,
    topObstacleCategories: [{ category: "waiting_material", count: 3 }, { category: "technical_issue", count: 1 }],
    reportCompliance: [
      { memberName: "Budi", reportedDays: 3, requiredDays: 6 },
      { memberName: "Siti", reportedDays: 2, requiredDays: 3, leaveDays: 3 },
    ],
    projectsTouched: ["Drone VEGA"],
  });
  assert.equal(
    text,
    [
      "📊 *Ringkasan mingguan* — minggu Sen, 3 Agu",
      "",
      "3 task selesai minggu ini",
      "",
      "*Masih terbuka*",
      "12 berjalan · 4 belum mulai · 3 terhambat",
      "",
      "*Masih terlambat (2)*",
      "• ⚠️ [G4] kalibrasi",
      "• ⚠️ Solder PCB",
      "",
      "*Kendala*",
      "• 2 kendala dilaporkan minggu ini",
      "• Terbanyak: menunggu material ×3 · masalah teknis ×1",
      "",
      "*Kepatuhan lapor*",
      "• Budi 3/6",
      "• Siti 2/3 (3 hari izin)",
      "",
      "*Project*",
      "• Drone VEGA",
    ].join("\n"),
  );
  assert.doesNotMatch(text, /overdue|blocked|in progress|active|stale|paused/);
});

test("a quiet week still renders a short, complete message", () => {
  const text = formatWeeklySummaryText({
    weekStart: "2026-08-03",
    completedThisWeek: [],
    openCounts: { active: 0, inProgress: 0, blocked: 0, stale: 0, paused: 0 },
    stillOverdue: [],
    obstaclesRaisedCount: 0,
    topObstacleCategories: [],
    reportCompliance: [],
    projectsTouched: [],
  });
  assert.equal(text, "📊 *Ringkasan mingguan* — minggu Sen, 3 Agu\n\n0 task selesai minggu ini\n\n*Masih terbuka*\nTidak ada task terbuka");
});
