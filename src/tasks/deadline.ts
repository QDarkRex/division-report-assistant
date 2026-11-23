import { calendarDayDiff, calendarDayOf, fromJakartaWallClock, type CalendarDay } from "../shared/time.ts";

export type DeadlineStage = "far" | "h3" | "h1" | "due_today" | "overdue";

/**
 * MASTER_SPEC.md §8: "deadline tanggal N" means the task must be finished
 * by tanggal (N-1) 23:59 Jakarta, equivalently "before tanggal N 00:00 Jakarta".
 * `deadlineLabelDay` is the labeled day (N); the returned instant is the
 * exclusive boundary — the task is overdue once `now >= mustFinishBefore`.
 */
export function computeMustFinishBefore(deadlineLabelDay: CalendarDay): Date {
  return fromJakartaWallClock(deadlineLabelDay.year, deadlineLabelDay.month, deadlineLabelDay.day, 0, 0, 0, 0);
}

/** The last day the task can still be finished on time (tanggal N-1). */
export function lastFinishDay(mustFinishBefore: Date): CalendarDay {
  return calendarDayOf(new Date(mustFinishBefore.getTime() - 1));
}

/**
 * Buckets `now` relative to the deadline per MASTER_SPEC.md §8 reminder
 * rules. This only classifies which day-bucket a task falls into; exact
 * time-of-day dispatch (08:00 vs 16:00 reminder) is a scheduler concern
 * (Phase 3), not part of this deterministic calculation.
 */
export function classifyDeadlineStage(now: Date, mustFinishBefore: Date): DeadlineStage {
  if (now.getTime() >= mustFinishBefore.getTime()) {
    return "overdue";
  }
  const finishDay = lastFinishDay(mustFinishBefore);
  const daysRemaining = calendarDayDiff(finishDay, calendarDayOf(now));
  if (daysRemaining === 0) return "due_today";
  if (daysRemaining === 1) return "h1";
  if (daysRemaining === 3) return "h3";
  return "far";
}
