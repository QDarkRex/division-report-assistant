import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import { createTask, setDeadline, transitionStatus } from "../tasks/service.ts";
import { fromJakartaWallClock } from "../shared/time.ts";
import { classifyOpenTasksByDeadline } from "./deadline-reminders.ts";

async function setupTaskWithDeadline(db: Awaited<ReturnType<typeof createTestDb>>, deadlineDay: number) {
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: `Task deadline ${deadlineDay}`, createdByMemberId: admin.memberId });
  await setDeadline(db, task.taskId, `tanggal ${deadlineDay}`, { year: 2026, month: 8, day: deadlineDay });
  return task;
}

test("tasks are grouped into h3/h1/due_today/overdue by their deadline", async () => {
  const db = await createTestDb();
  // deadline "tanggal 10" -> last finish day is the 9th
  const h3Task = await setupTaskWithDeadline(db, 10);
  const h1Task = await setupTaskWithDeadline(db, 8);
  const dueTodayTask = await setupTaskWithDeadline(db, 7);
  const overdueTask = await setupTaskWithDeadline(db, 6);

  const now = fromJakartaWallClock(2026, 8, 6, 8, 0);
  const groups = await classifyOpenTasksByDeadline(db, now);

  assert.deepEqual(groups.h3.map((t) => t.taskId), [h3Task.taskId]);
  assert.deepEqual(groups.h1.map((t) => t.taskId), [h1Task.taskId]);
  assert.deepEqual(groups.dueToday.map((t) => t.taskId), [dueTodayTask.taskId]);
  assert.deepEqual(groups.overdue.map((t) => t.taskId), [overdueTask.taskId]);
});

test("a task without a deadline never appears in any reminder group", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  await createTask(db, { title: "No deadline task", createdByMemberId: admin.memberId });

  const groups = await classifyOpenTasksByDeadline(db, fromJakartaWallClock(2026, 8, 6, 8, 0));
  assert.deepEqual(groups, { h3: [], h1: [], dueToday: [], overdue: [] });
});

test("cancelled and done tasks are excluded even if their deadline would otherwise flag them", async () => {
  const db = await createTestDb();
  const task = await setupTaskWithDeadline(db, 6); // would be overdue
  await transitionStatus(db, task.taskId, "admin_cancel");

  const groups = await classifyOpenTasksByDeadline(db, fromJakartaWallClock(2026, 8, 6, 8, 0));
  assert.deepEqual(groups.overdue, []);
});
