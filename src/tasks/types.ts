import type { tasks, taskObstacles, pendingActions, candidateTasks } from "../db/schema.ts";

export type Task = typeof tasks.$inferSelect;
export type TaskObstacle = typeof taskObstacles.$inferSelect;
export type PendingActionRow = typeof pendingActions.$inferSelect;
export type CandidateTask = typeof candidateTasks.$inferSelect;

export interface CreateTaskInput {
  title: string;
  createdByMemberId: string;
  projectId?: string;
  sourceReference?: string;
  /** The working day this is meant to happen on — see tasks.scheduledFor. Not a deadline. */
  scheduledFor?: string;
}
