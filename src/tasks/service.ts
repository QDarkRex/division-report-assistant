import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { members, pendingActions, taskAssignees, taskContributors, taskEvents, taskObstacles, tasks } from "../db/schema.ts";
import { canRequestPendingAction, type PendingActionType } from "./pending-action.ts";
import { isValidStatusTransition, type StatusTransitionTrigger, type TaskStatus } from "./state-machine.ts";
import type { CalendarDay } from "../shared/time.ts";
import { computeMustFinishBefore } from "./deadline.ts";
import type { CreateTaskInput, PendingActionRow, Task } from "./types.ts";

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function createTask(db: AppDatabase, input: CreateTaskInput): Promise<Task> {
  const [task] = await db
    .insert(tasks)
    .values({
      title: input.title,
      normalizedTitle: normalizeTitle(input.title),
      projectId: input.projectId,
      createdByMemberId: input.createdByMemberId,
      sourceReference: input.sourceReference,
      scheduledFor: input.scheduledFor,
    })
    .returning();
  if (!task) throw new Error("task insert returned no row");
  return task;
}

export async function getTask(db: AppDatabase, taskId: string): Promise<Task | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1);
  return task ?? null;
}

/**
 * MASTER_SPEC.md §10: "Similar tasks must not be auto-merged." Exact
 * normalized-title match only — anything less exact must go through the
 * candidate-task flow (./candidates.ts) instead of silently matching.
 */
export async function findTaskByNormalizedTitle(db: AppDatabase, title: string): Promise<Task | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.normalizedTitle, normalizeTitle(title))).limit(1);
  return task ?? null;
}

export async function listTasksByStatus(db: AppDatabase, status: TaskStatus): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.status, status));
}

/** MASTER_SPEC.md §6.2 — admin assigns a member to a task. */
export async function assignMember(db: AppDatabase, taskId: string, memberId: string): Promise<void> {
  await db.insert(taskAssignees).values({ taskId, memberId }).onConflictDoNothing();
}

/**
 * Permission engine's `claim` action, applied: the mechanism by which a
 * member becomes a contributor is reporting work against a task — this is
 * the write side of that. Idempotent: reporting again just doesn't insert
 * a duplicate row.
 */
export async function claimTask(db: AppDatabase, taskId: string, memberId: string): Promise<void> {
  await db.insert(taskContributors).values({ taskId, memberId }).onConflictDoNothing();
}

/**
 * Applies a validated state-machine transition (see ./state-machine.ts)
 * and records the change as an append-only task_events row. Throws if the
 * transition isn't in the table — callers must check
 * `isValidStatusTransition` themselves if they want to handle rejection
 * without a thrown error (e.g. to message the user "can't do that").
 *
 * Found 2026-08-08 (Opus design review, ahead of building two-way Sheets
 * sync): `tasks.version` existed in the schema for optimistic-locking
 * conflict detection but was bumped by NO write path in this file — every
 * update here just set columns and left version untouched. Building the
 * Sheets import's conflict check on top of that would have made the lock
 * completely vacuous while looking correct in review (the lock code
 * would be present, well-formed, and never actually detect a conflict,
 * since the sheet's version would always match). Every db.update(tasks)
 * in this file now bumps version in the same statement.
 */
export async function transitionStatus(
  db: AppDatabase,
  taskId: string,
  trigger: StatusTransitionTrigger,
  actorMemberId?: string,
): Promise<Task> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1);
    if (!task) throw new Error(`task ${taskId} not found`);

    const to = transitionTarget(task.status, trigger);
    if (!to) {
      throw new Error(`no transition for trigger "${trigger}" from status "${task.status}"`);
    }

    const [updated] = await tx
      .update(tasks)
      .set({ status: to, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
      .where(eq(tasks.taskId, taskId))
      .returning();
    if (!updated) throw new Error("task update returned no row");

    await tx.insert(taskEvents).values({
      taskId,
      eventType: trigger,
      actorMemberId,
      fromStatus: task.status,
      toStatus: to,
    });

    return updated;
  });
}

/** Resolves the transition target without needing the caller to enumerate every possible `to` status. */
function transitionTarget(from: TaskStatus, trigger: StatusTransitionTrigger): TaskStatus | null {
  const candidates: TaskStatus[] = [
    "active",
    "active_unreviewed",
    "in_progress",
    "blocked",
    "paused",
    "stale",
    "status_conflict",
    "done",
    "cancelled",
  ];
  return candidates.find((to) => isValidStatusTransition(from, to, trigger)) ?? null;
}

/** MASTER_SPEC.md §8: stores both the human label and the computed exclusive deadline boundary. */
export async function setDeadline(
  db: AppDatabase,
  taskId: string,
  deadlineLabel: string,
  deadlineLabelDay: CalendarDay,
): Promise<void> {
  const mustFinishBefore = computeMustFinishBefore(deadlineLabelDay);
  await db
    .update(tasks)
    .set({ deadlineLabel, mustFinishBefore, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
    .where(eq(tasks.taskId, taskId));
}

export async function recordObstacle(
  db: AppDatabase,
  taskId: string,
  description: string,
  reportedByMemberId?: string,
): Promise<void> {
  await db.insert(taskObstacles).values({ taskId, description, reportedByMemberId });
}

export async function resolveObstacle(db: AppDatabase, obstacleId: string): Promise<void> {
  await db.update(taskObstacles).set({ resolved: true, resolvedAt: new Date() }).where(eq(taskObstacles.obstacleId, obstacleId));
}

export async function listOpenObstacles(db: AppDatabase, taskId: string) {
  return db.select().from(taskObstacles).where(and(eq(taskObstacles.taskId, taskId), eq(taskObstacles.resolved, false)));
}

/**
 * ACCEPTANCE_TESTS.md §3.4: "Member departure with active assignments
 * creates reassignment handling — needs_reassignment: true." Scans the
 * departing member's active assignments and flags each task; does not
 * reassign automatically (that's an admin/handoff decision).
 */
export async function handleMemberDeparture(db: AppDatabase, memberId: string): Promise<Task[]> {
  const assigned = await db
    .select({ task: tasks })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.taskId))
    .where(eq(taskAssignees.memberId, memberId));

  const openStatuses: TaskStatus[] = ["active", "active_unreviewed", "in_progress", "blocked", "paused", "stale"];
  const affected = assigned.map((row) => row.task).filter((task) => openStatuses.includes(task.status));

  const updated: Task[] = [];
  for (const task of affected) {
    const [row] = await db
      .update(tasks)
      .set({ needsReassignment: true, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
      .where(eq(tasks.taskId, task.taskId))
      .returning();
    if (row) updated.push(row);
  }
  return updated;
}

/**
 * §6.1: a non-admin cannot cancel/handoff a task directly — they propose,
 * and it becomes a pending_actions row. Enforces the same source-status
 * rules as ./pending-action.ts and the "at most one open proposal per
 * type" partial unique index in the schema (a second concurrent request
 * throws here rather than silently duplicating).
 */
export async function requestPendingAction(
  db: AppDatabase,
  taskId: string,
  actionType: PendingActionType,
  requestedByMemberId: string,
  targetMemberId?: string,
): Promise<PendingActionRow> {
  const task = await getTask(db, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (!canRequestPendingAction(task.status, actionType)) {
    throw new Error(`cannot request "${actionType}" from task status "${task.status}"`);
  }

  const [row] = await db
    .insert(pendingActions)
    .values({ taskId, actionType, requestedByMemberId, targetMemberId })
    .returning();
  if (!row) throw new Error("pending action insert returned no row");
  return row;
}

/**
 * Deciding a pending action applies its real-world side effect:
 * - cancellation, accepted -> task transitions to cancelled;
 * - handoff, accepted -> the requester's assignment moves to the target member;
 * - rejected (any type) -> no task-level side effect, just closes the proposal.
 * project_confirmation has no task-level side effect here — confirming the
 * *project* is projects/service.ts's `confirmProject`.
 */
export async function decidePendingAction(
  db: AppDatabase,
  pendingActionId: string,
  decision: "accepted" | "rejected",
  decidedByMemberId: string,
): Promise<PendingActionRow> {
  return db.transaction(async (tx) => {
    const [pending] = await tx.select().from(pendingActions).where(eq(pendingActions.pendingActionId, pendingActionId)).limit(1);
    if (!pending) throw new Error(`pending action ${pendingActionId} not found`);
    if (pending.state !== "pending") throw new Error(`pending action ${pendingActionId} already decided`);

    const [updated] = await tx
      .update(pendingActions)
      .set({ state: decision, decidedByMemberId, decidedAt: new Date() })
      .where(eq(pendingActions.pendingActionId, pendingActionId))
      .returning();
    if (!updated) throw new Error("pending action update returned no row");

    if (decision === "accepted" && pending.actionType === "cancellation") {
      await tx
        .update(tasks)
        .set({ status: "cancelled", updatedAt: new Date(), version: sql`${tasks.version} + 1` })
        .where(eq(tasks.taskId, pending.taskId));
      await tx.insert(taskEvents).values({
        taskId: pending.taskId,
        eventType: "admin_cancel",
        actorMemberId: decidedByMemberId,
        toStatus: "cancelled",
      });
    }

    if (decision === "accepted" && pending.actionType === "handoff" && pending.targetMemberId) {
      await tx
        .delete(taskAssignees)
        .where(and(eq(taskAssignees.taskId, pending.taskId), eq(taskAssignees.memberId, pending.requestedByMemberId)));
      await tx
        .insert(taskAssignees)
        .values({ taskId: pending.taskId, memberId: pending.targetMemberId })
        .onConflictDoNothing();
    }

    return updated;
  });
}

export { canRequestPendingAction, type PendingActionType } from "./pending-action.ts";

/**
 * Everyone currently assigned to any of these tasks, de-duplicated.
 *
 * Exists for the deadline reminder, which should tag the people holding
 * the work rather than the whole group — a reminder that pings 17 people
 * to reach 2 of them is how a group learns to mute the bot.
 */
export async function listAssigneesForTasks(
  db: AppDatabase,
  taskIds: readonly string[],
): Promise<Array<{ memberId: string; preferredName: string }>> {
  if (taskIds.length === 0) return [];

  const rows = await db
    .select({ memberId: members.memberId, preferredName: members.preferredName })
    .from(taskAssignees)
    .innerJoin(members, eq(taskAssignees.memberId, members.memberId))
    .where(and(inArray(taskAssignees.taskId, [...taskIds]), eq(members.membershipStatus, "active")));

  const byId = new Map(rows.map((r) => [r.memberId, r]));
  return [...byId.values()];
}
