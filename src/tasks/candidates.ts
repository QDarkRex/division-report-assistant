import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { candidateTasks, tasks } from "../db/schema.ts";
import { createTask } from "./service.ts";
import type { CandidateTask, Task } from "./types.ts";

/**
 * ADR-0016: the pipeline no longer proposes candidate tasks (96.9% of report items became one, none was ever
 * decided by a human). The table and its data stay. Rollback = set this to true and disable the weekly recap job.
 */
export const CANDIDATE_TASKS_ENABLED = false;

/** MASTER_SPEC.md §10: an unmatched report activity creates a candidate task. */
export async function createCandidateTask(
  db: AppDatabase,
  input: { reportItemId: string; createdByMemberId: string; suggestedTitle: string; matchedTaskId?: string },
): Promise<CandidateTask> {
  const [candidate] = await db
    .insert(candidateTasks)
    .values({
      reportItemId: input.reportItemId,
      createdByMemberId: input.createdByMemberId,
      suggestedTitle: input.suggestedTitle,
      matchedTaskId: input.matchedTaskId,
    })
    .returning();
  if (!candidate) throw new Error("candidate task insert returned no row");
  return candidate;
}

export async function listUnresolvedCandidates(db: AppDatabase): Promise<CandidateTask[]> {
  return db.select().from(candidateTasks).where(isNull(candidateTasks.resolvedAt));
}

/** ACCEPTANCE_TESTS.md §3.1: shown in at most 3 morning summaries before auto-promotion. */
export async function incrementShownCount(db: AppDatabase, candidateId: string): Promise<void> {
  const [candidate] = await db.select().from(candidateTasks).where(eq(candidateTasks.candidateId, candidateId)).limit(1);
  if (!candidate) throw new Error(`candidate ${candidateId} not found`);
  await db
    .update(candidateTasks)
    .set({ summariesShownCount: candidate.summariesShownCount + 1 })
    .where(eq(candidateTasks.candidateId, candidateId));
}

/** §10: "buat task" — confirms the candidate as a new (or existing) task. */
export async function resolveCandidateAsTask(db: AppDatabase, candidateId: string, taskTitle?: string): Promise<Task> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(candidateTasks).where(eq(candidateTasks.candidateId, candidateId)).limit(1);
    if (!candidate) throw new Error(`candidate ${candidateId} not found`);
    if (candidate.resolvedAt) throw new Error(`candidate ${candidateId} already resolved`);

    const task = await createTask(tx as AppDatabase, {
      title: taskTitle ?? candidate.suggestedTitle,
      createdByMemberId: candidate.createdByMemberId,
    });

    await tx
      .update(candidateTasks)
      .set({ resolvedAt: new Date(), resolvedAsTaskId: task.taskId })
      .where(eq(candidateTasks.candidateId, candidateId));

    return task;
  });
}

/** §10: "hanya aktivitas" — the report item stands on its own, no task created. */
export async function resolveCandidateAsActivityOnly(db: AppDatabase, candidateId: string): Promise<void> {
  await db
    .update(candidateTasks)
    .set({ resolvedAt: new Date() })
    .where(and(eq(candidateTasks.candidateId, candidateId), isNull(candidateTasks.resolvedAt)));
}

/**
 * ACCEPTANCE_TESTS.md §3.1: "Candidate task unanswered after 3 morning
 * summaries becomes active_unreviewed." Auto-creates the task (status
 * active_unreviewed) for every unresolved candidate that's hit the shown-3x
 * threshold. Intended to be called once per morning-summary run
 * (Phase 3 scheduler) — idempotent because it only touches unresolved rows.
 */
export async function promoteStaleCandidates(db: AppDatabase, thresholdShownCount = 3): Promise<Task[]> {
  const unresolved = await listUnresolvedCandidates(db);
  const due = unresolved.filter((c) => c.summariesShownCount >= thresholdShownCount);

  const promoted: Task[] = [];
  for (const candidate of due) {
    const task = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tasks)
        .values({
          title: candidate.suggestedTitle,
          normalizedTitle: candidate.suggestedTitle.trim().toLowerCase().replace(/\s+/g, " "),
          status: "active_unreviewed",
          createdByMemberId: candidate.createdByMemberId,
        })
        .returning();
      if (!created) throw new Error("task insert returned no row");

      await tx
        .update(candidateTasks)
        .set({ resolvedAt: new Date(), resolvedAsTaskId: created.taskId })
        .where(eq(candidateTasks.candidateId, candidate.candidateId));

      return created;
    });
    promoted.push(task);
  }
  return promoted;
}
