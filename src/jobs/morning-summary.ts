import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { taskEvents, taskObstacles, tasks } from "../db/schema.ts";
import { listTasksByStatus } from "../tasks/service.ts";
import { listMembersOnLeave } from "../members/availability.ts";
import type { Member } from "../members/types.ts";
import { addCalendarDays, calendarDayOf, fromJakartaWallClock } from "../shared/time.ts";
import { classifyOpenTasksByDeadline } from "./deadline-reminders.ts";
import type { Task } from "../tasks/types.ts";

export interface MorningSummary {
  active: Task[];
  dueToday: Task[];
  overdue: Task[];
  blocked: Task[];
  activeObstacleCount: number;
  stale: Task[];
  paused: Task[];
  noDeadline: Task[];
  noProject: Task[];
  completedYesterday: Task[];
  onLeaveToday: Member[];
}

async function listCompletedYesterday(db: AppDatabase, now: Date): Promise<Task[]> {
  const today = calendarDayOf(now);
  const yesterday = addCalendarDays(today, -1);
  const dayStart = fromJakartaWallClock(yesterday.year, yesterday.month, yesterday.day, 0, 0, 0, 0);
  const dayEnd = fromJakartaWallClock(today.year, today.month, today.day, 0, 0, 0, 0);

  const events = await db
    .select({ taskId: taskEvents.taskId })
    .from(taskEvents)
    .where(and(eq(taskEvents.toStatus, "done"), gte(taskEvents.createdAt, dayStart), lt(taskEvents.createdAt, dayEnd)));

  const taskIds = [...new Set(events.map((e) => e.taskId))];
  if (taskIds.length === 0) return [];
  return db.select().from(tasks).where(inArray(tasks.taskId, taskIds));
}

/**
 * MASTER_SPEC.md §11.1: active tasks, due today, overdue, blocked, active
 * obstacles, stale, paused, no deadline, no project, completed yesterday
 *. No member tagging — see the ban-risk decision in the
 * WDH README; this returns data, the caller renders/sends it as plain text.
 */
export async function buildMorningSummary(db: AppDatabase, now: Date = new Date()): Promise<MorningSummary> {
  const [active, blocked, stale, paused, deadlineGroups, completedYesterday, openObstacles, onLeaveToday] =
    await Promise.all([
      listTasksByStatus(db, "active"),
      listTasksByStatus(db, "blocked"),
      listTasksByStatus(db, "stale"),
      listTasksByStatus(db, "paused"),
      classifyOpenTasksByDeadline(db, now),
      listCompletedYesterday(db, now),
      db.select().from(taskObstacles).where(eq(taskObstacles.resolved, false)),
      listMembersOnLeave(db, calendarDayOf(now)),
    ]);

  const openStatusesForNoDeadlineNoProject = ["active", "active_unreviewed", "in_progress", "blocked", "paused", "stale"] as const;
  const openTaskLists = await Promise.all(openStatusesForNoDeadlineNoProject.map((s) => listTasksByStatus(db, s)));
  const openTasks = openTaskLists.flat();

  return {
    active,
    dueToday: deadlineGroups.dueToday,
    overdue: deadlineGroups.overdue,
    blocked,
    activeObstacleCount: openObstacles.length,
    stale,
    paused,
    noDeadline: openTasks.filter((t) => t.mustFinishBefore === null),
    noProject: openTasks.filter((t) => t.projectId === null),
    completedYesterday,
    onLeaveToday,
  };
}
