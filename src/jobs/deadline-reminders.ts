import type { AppDatabase } from "../db/types.ts";
import { classifyDeadlineStage } from "../tasks/deadline.ts";
import { listTasksByStatus } from "../tasks/service.ts";
import type { TaskStatus } from "../tasks/state-machine.ts";
import type { Task } from "../tasks/types.ts";

const OPEN_STATUSES: readonly TaskStatus[] = ["active", "active_unreviewed", "in_progress", "blocked", "paused", "stale"];

export interface DeadlineReminderGroups {
  h3: Task[];
  h1: Task[];
  dueToday: Task[];
  overdue: Task[];
}

/** MASTER_SPEC.md §8 reminder rules, applied across every open task with a deadline. */
export async function classifyOpenTasksByDeadline(db: AppDatabase, now: Date = new Date()): Promise<DeadlineReminderGroups> {
  const openTaskLists = await Promise.all(OPEN_STATUSES.map((status) => listTasksByStatus(db, status)));
  const openTasks = openTaskLists.flat().filter((task) => task.mustFinishBefore !== null);

  const groups: DeadlineReminderGroups = { h3: [], h1: [], dueToday: [], overdue: [] };
  for (const task of openTasks) {
    const stage = classifyDeadlineStage(now, task.mustFinishBefore as Date);
    if (stage === "h3") groups.h3.push(task);
    else if (stage === "h1") groups.h1.push(task);
    else if (stage === "due_today") groups.dueToday.push(task);
    else if (stage === "overdue") groups.overdue.push(task);
  }
  return groups;
}
