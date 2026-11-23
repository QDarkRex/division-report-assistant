import type { AppDatabase } from "../db/types.ts";
import { listTasksByStatus, transitionStatus } from "../tasks/service.ts";
import type { Task } from "../tasks/types.ts";
import { isPlanTask } from "../plan/mapping.ts";

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ACCEPTANCE_TESTS.md §3.2: "Stale detection | in_progress | 7 days no
 * update | stale". `updated_at` is the update reference point — every
 * transitionStatus() call bumps it, so 7 days with no status change is a
 * reasonable proxy for "no update" without needing a separate activity
 * timestamp. Intended to run daily via pg-boss (Phase 3 wiring, not done
 * here — this is the tested job logic, not the schedule registration).
 */
export async function detectStaleTasks(db: AppDatabase, now: Date = new Date()): Promise<Task[]> {
  const inProgress = await listTasksByStatus(db, "in_progress");
  // Plan tasks are skipped: their status is whatever the supervisor's plan
  // says (src/plan/sync.ts), so a week without a status change on a step that
  // is simply still Berjalan in the sheet is not staleness, and flipping it to
  // "stale" here would be undone — and re-announced as a change — by the next sync.
  const overdue = inProgress.filter(
    (task) => !isPlanTask(task.sourceReference) && now.getTime() - task.updatedAt.getTime() >= STALE_THRESHOLD_MS,
  );

  const results: Task[] = [];
  for (const task of overdue) {
    results.push(await transitionStatus(db, task.taskId, "stale_detected"));
  }
  return results;
}
