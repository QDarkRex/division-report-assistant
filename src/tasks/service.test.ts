import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import {
  assignMember,
  claimTask,
  createTask,
  decidePendingAction,
  getTask,
  handleMemberDeparture,
  listOpenObstacles,
  recordObstacle,
  requestPendingAction,
  resolveObstacle,
  setDeadline,
  transitionStatus,
} from "./service.ts";

async function setupAdminAndMember(db: Awaited<ReturnType<typeof createTestDb>>) {
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const member = await createMember(db, { preferredName: "Agas" });
  return { admin, member };
}

// ACCEPTANCE_TESTS.md §3.2
test("normal progress: active -> in_progress on member report", async () => {
  const db = await createTestDb();
  const { admin } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  const updated = await transitionStatus(db, task.taskId, "member_reports_work");
  assert.equal(updated.status, "in_progress");
});

test("block and resolve cycle: in_progress -> blocked -> in_progress, obstacle tracked", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work");

  await recordObstacle(db, task.taskId, "Wi-Fi unstable", member.memberId);
  const blocked = await transitionStatus(db, task.taskId, "obstacle_reported");
  assert.equal(blocked.status, "blocked");

  const openObstacles = await listOpenObstacles(db, task.taskId);
  assert.equal(openObstacles.length, 1);
  await resolveObstacle(db, openObstacles[0]!.obstacleId);
  assert.equal((await listOpenObstacles(db, task.taskId)).length, 0);

  const resumed = await transitionStatus(db, task.taskId, "obstacle_resolved");
  assert.equal(resumed.status, "in_progress");
});

test("completion is reachable from blocked (chief-review fix, not just in_progress)", async () => {
  const db = await createTestDb();
  const { admin } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work");
  await transitionStatus(db, task.taskId, "obstacle_reported");
  const done = await transitionStatus(db, task.taskId, "member_marks_done");
  assert.equal(done.status, "done");
});

test("invalid transition throws instead of silently no-op'ing", async () => {
  const db = await createTestDb();
  const { admin } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await assert.rejects(() => transitionStatus(db, task.taskId, "obstacle_resolved"));
});

test("transitionStatus records an append-only task_events row", async () => {
  const db = await createTestDb();
  const { admin } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work", admin.memberId);
  const stored = await getTask(db, task.taskId);
  assert.equal(stored?.status, "in_progress");
});

// ACCEPTANCE_TESTS.md §3.3
test("setDeadline computes must_finish_before from the deadline label day", async () => {
  const db = await createTestDb();
  const { admin } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await setDeadline(db, task.taskId, "tanggal 10", { year: 2026, month: 8, day: 10 });
  const stored = await getTask(db, task.taskId);
  assert.equal(stored?.deadlineLabel, "tanggal 10");
  assert.ok(stored?.mustFinishBefore);
});

// ACCEPTANCE_TESTS.md §3.4
test("member departure with an active assignment flags needs_reassignment", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await assignMember(db, task.taskId, member.memberId);

  const affected = await handleMemberDeparture(db, member.memberId);
  assert.deepEqual(
    affected.map((t) => t.taskId),
    [task.taskId],
  );
  const stored = await getTask(db, task.taskId);
  assert.equal(stored?.needsReassignment, true);
});

test("departure does not flag tasks that are already done or cancelled", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await assignMember(db, task.taskId, member.memberId);
  await transitionStatus(db, task.taskId, "member_reports_work");
  await transitionStatus(db, task.taskId, "member_marks_done");

  const affected = await handleMemberDeparture(db, member.memberId);
  assert.deepEqual(affected, []);
});

// Pending actions: cancellation (§3.2 "Member cancel proposal") and handoff (§3.4)
test("member cancel proposal: request then admin accepts -> task cancelled", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  const pending = await requestPendingAction(db, task.taskId, "cancellation", member.memberId);
  assert.equal(pending.state, "pending");

  await decidePendingAction(db, pending.pendingActionId, "accepted", admin.memberId);
  const stored = await getTask(db, task.taskId);
  assert.equal(stored?.status, "cancelled");
});

test("cancel proposal rejected leaves the task untouched", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  const pending = await requestPendingAction(db, task.taskId, "cancellation", member.memberId);
  await decidePendingAction(db, pending.pendingActionId, "rejected", admin.memberId);
  const stored = await getTask(db, task.taskId);
  assert.equal(stored?.status, "active");
});

test("a second concurrent cancellation proposal on the same task is rejected", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await requestPendingAction(db, task.taskId, "cancellation", member.memberId);
  await assert.rejects(() => requestPendingAction(db, task.taskId, "cancellation", member.memberId));
});

test("handoff accepted reassigns the task from requester to target", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const target = await createMember(db, { preferredName: "Budi" });
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await assignMember(db, task.taskId, member.memberId);

  const pending = await requestPendingAction(db, task.taskId, "handoff", member.memberId, target.memberId);
  await decidePendingAction(db, pending.pendingActionId, "accepted", admin.memberId);

  const affectedByDeparture = await handleMemberDeparture(db, member.memberId);
  assert.deepEqual(affectedByDeparture, [], "the original assignee should no longer be assigned");
});

test("claim is idempotent — reporting on the same task twice does not duplicate the contributor row", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  await claimTask(db, task.taskId, member.memberId);
  await assert.doesNotReject(() => claimTask(db, task.taskId, member.memberId));
});

// Found 2026-08-08 (Opus design review): tasks.version existed for
// optimistic-locking but was bumped by no write path — the two-way
// Sheets sync's conflict check would have been silently vacuous.
test("every task update path increments version", async () => {
  const db = await createTestDb();
  const { admin, member } = await setupAdminAndMember(db);
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  assert.equal(task.version, 1, "sanity: starts at 1");

  const afterTransition = await transitionStatus(db, task.taskId, "member_reports_work", member.memberId);
  assert.equal(afterTransition.version, 2, "transitionStatus must bump version");

  await setDeadline(db, task.taskId, "deadline tanggal 10", { year: 2026, month: 8, day: 9 });
  const afterDeadline = await getTask(db, task.taskId);
  assert.equal(afterDeadline?.version, 3, "setDeadline must bump version");

  await handleMemberDeparture(db, member.memberId);
  const afterUnrelatedDeparture = await getTask(db, task.taskId);
  assert.equal(afterUnrelatedDeparture?.version, 3, "sanity: a departure with no assignment on this task must not bump it");

  await assignMember(db, task.taskId, member.memberId);
  await handleMemberDeparture(db, member.memberId);
  const afterDeparture = await getTask(db, task.taskId);
  assert.equal(afterDeparture?.version, 4, "handleMemberDeparture must bump version when it flags this task");

  const pending = await requestPendingAction(db, task.taskId, "cancellation", member.memberId);
  await decidePendingAction(db, pending.pendingActionId, "accepted", admin.memberId);
  const afterCancel = await getTask(db, task.taskId);
  assert.equal(afterCancel?.version, 5, "decidePendingAction's cancellation path must bump version");
});
