import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { taskEvents } from "../db/schema.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { setAvailability } from "../members/availability.ts";
import { createProject } from "../projects/service.ts";
import { createTask, recordObstacle, setDeadline, transitionStatus } from "../tasks/service.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { fromJakartaWallClock } from "../shared/time.ts";
import { buildMorningSummary } from "./morning-summary.ts";

test("morning summary buckets tasks into the sections MASTER_SPEC §11.1 requires", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const project = await createProject(db, { name: "Panel Upgrade" });

  const active = await createTask(db, { title: "Active task", createdByMemberId: admin.memberId, projectId: project.projectId });

  const blocked = await createTask(db, { title: "Blocked task", createdByMemberId: admin.memberId });
  await transitionStatus(db, blocked.taskId, "member_reports_work");
  await recordObstacle(db, blocked.taskId, "Wi-Fi unstable");
  await transitionStatus(db, blocked.taskId, "obstacle_reported");

  const overdueTask = await createTask(db, { title: "Overdue task", createdByMemberId: admin.memberId });
  await setDeadline(db, overdueTask.taskId, "tanggal 6", { year: 2026, month: 8, day: 6 });

  const noDeadlineNoProject = await createTask(db, { title: "Bare task", createdByMemberId: admin.memberId });


  const now = fromJakartaWallClock(2026, 8, 6, 8, 0);
  const summary = await buildMorningSummary(db, now);

  assert.deepEqual(summary.active.map((t) => t.taskId).sort(), [active.taskId, overdueTask.taskId, noDeadlineNoProject.taskId].sort());
  assert.deepEqual(summary.blocked.map((t) => t.taskId), [blocked.taskId]);
  assert.deepEqual(summary.overdue.map((t) => t.taskId), [overdueTask.taskId]);
  assert.equal(summary.activeObstacleCount, 1);
  // blocked has no deadline either — it's an open-status task, so it belongs
  // in noDeadline too, same as active/noDeadlineNoProject.
  assert.deepEqual(
    summary.noDeadline.map((t) => t.taskId).sort(),
    [active.taskId, blocked.taskId, noDeadlineNoProject.taskId].sort(),
  );
  assert.ok(summary.noProject.map((t) => t.taskId).includes(noDeadlineNoProject.taskId));
});

test("a task completed the previous calendar day appears in completedYesterday", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Finished task", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work");
  await transitionStatus(db, task.taskId, "member_marks_done");

  // Backdate the completion event to yesterday noon — transitionStatus always
  // stamps createdAt with the real clock, so this simulates "now" having
  // moved on to the next day by the time the morning-summary job runs.
  const yesterdayNoon = fromJakartaWallClock(2026, 8, 5, 12, 0);
  await db.update(taskEvents).set({ createdAt: yesterdayNoon }).where(eq(taskEvents.taskId, task.taskId));

  const todayMorning = fromJakartaWallClock(2026, 8, 6, 8, 0);
  const summary = await buildMorningSummary(db, todayMorning);
  assert.deepEqual(
    summary.completedYesterday.map((t) => t.taskId),
    [task.taskId],
  );

  const dayAfterMorning = fromJakartaWallClock(2026, 8, 7, 8, 0);
  const laterSummary = await buildMorningSummary(db, dayAfterMorning);
  assert.deepEqual(laterSummary.completedYesterday, [], "the task should only appear in exactly one day's summary");
});

// d3 (attendance/leave)
test("a member on leave today appears in onLeaveToday", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  const now = fromJakartaWallClock(2026, 8, 6, 8, 0);
  await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day: 6 });

  const summary = await buildMorningSummary(db, now);
  assert.deepEqual(
    summary.onLeaveToday.map((m) => m.memberId),
    [member.memberId],
  );
});
