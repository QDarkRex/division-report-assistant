import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import { createTask, getTask, transitionStatus } from "../tasks/service.ts";
import { tasks } from "../db/schema.ts";
import { detectStaleTasks } from "./stale-detection.ts";

async function backdateUpdatedAt(db: Awaited<ReturnType<typeof createTestDb>>, taskId: string, updatedAt: Date) {
  await db.update(tasks).set({ updatedAt }).where(eq(tasks.taskId, taskId));
}

test("an in_progress task untouched for 7+ days is marked stale", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work");

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await backdateUpdatedAt(db, task.taskId, eightDaysAgo);

  const stale = await detectStaleTasks(db);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.status, "stale");

  const stored = await getTask(db, task.taskId);
  assert.equal(stored?.status, "stale");
});

test("a task updated recently is left alone", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work");

  const stale = await detectStaleTasks(db);
  assert.deepEqual(stale, []);
  const stored = await getTask(db, task.taskId);
  assert.equal(stored?.status, "in_progress");
});

test("only in_progress tasks are candidates — active/blocked/done are not touched", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const activeTask = await createTask(db, { title: "Untouched active task", createdByMemberId: admin.memberId });
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await backdateUpdatedAt(db, activeTask.taskId, eightDaysAgo);

  const stale = await detectStaleTasks(db);
  assert.deepEqual(stale, []);
});

// The plan, not elapsed time, decides a plan task's status: a step that is
// still Berjalan in the sheet is not stale, and a stale flip here would be
// reverted (and announced as a plan change) by the next sync.
test("a master-plan task is never marked stale, however long since its last update", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const planTask = await createTask(db, { title: "BMS: Soldering", createdByMemberId: admin.memberId, sourceReference: "master-plan-aerolift:1.01" });
  const plain = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  for (const task of [planTask, plain]) {
    await transitionStatus(db, task.taskId, "member_reports_work");
    await backdateUpdatedAt(db, task.taskId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  }

  const stale = await detectStaleTasks(db);

  assert.deepEqual(stale.map((t) => t.taskId), [plain.taskId]);
  assert.equal((await getTask(db, planTask.taskId))?.status, "in_progress");
});
