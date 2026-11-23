/**
 * Asia/Jakarta (WIB) is a fixed UTC+7 offset with no daylight saving time,
 * so a constant-offset conversion is correct year-round — no tz database
 * dependency is needed here.
 */
export const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface JakartaWallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export interface CalendarDay {
  year: number;
  month: number; // 1-12
  day: number;
}

/** Reads the Jakarta wall-clock components of a UTC instant. */
export function toJakartaWallClock(instant: Date): JakartaWallClock {
  const shifted = new Date(instant.getTime() + JAKARTA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

/** Builds the UTC instant corresponding to a Jakarta wall-clock time. */
export function fromJakartaWallClock(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - JAKARTA_OFFSET_MS;
  return new Date(utcMs);
}

export function calendarDayOf(instant: Date): CalendarDay {
  const { year, month, day } = toJakartaWallClock(instant);
  return { year, month, day };
}

export function addCalendarDays(day: CalendarDay, delta: number): CalendarDay {
  const base = fromJakartaWallClock(day.year, day.month, day.day, 12); // noon avoids DST-less edge cases entirely, kept for clarity
  const shifted = new Date(base.getTime() + delta * 24 * 60 * 60 * 1000);
  return calendarDayOf(shifted);
}

/** Whole-day difference (a - b), positive when a is later than b. */
export function calendarDayDiff(a: CalendarDay, b: CalendarDay): number {
  const aMs = fromJakartaWallClock(a.year, a.month, a.day, 12).getTime();
  const bMs = fromJakartaWallClock(b.year, b.month, b.day, 12).getTime();
  return Math.round((aMs - bMs) / (24 * 60 * 60 * 1000));
}

/**
 * Reporting day per MASTER_SPEC.md §9.1: a reporting day runs from
 * 10:00 Jakarta on day N through 09:59:59.999 Jakarta on day N+1.
 * Timestamps before 10:00 belong to the previous calendar day's window.
 */
export function reportingDayFor(instant: Date): CalendarDay {
  const wall = toJakartaWallClock(instant);
  const today: CalendarDay = { year: wall.year, month: wall.month, day: wall.day };
  return wall.hour < 10 ? addCalendarDays(today, -1) : today;
}

/**
 * The day an overtime CHECK-IN belongs to. Between 05:00 and 09:59 Jakarta the
 * reporting day would still be yesterday's (reportingDayFor), but a member who
 * says "lembur" at 09:17 on a Saturday means working today. Production
 * 2026-10-03: five Saturday-morning check-ins landed on Friday's reporting
 * day and created five empty overtime reports there. So a morning check-in
 * uses the CALENDAR day; the evening (10:00-23:59) and after-midnight
 * (00:00-04:59) cases keep the reporting day, which is already right for both
 * (an after-midnight "lembur" continues the evening before).
 */
export function overtimeCheckinDayFor(instant: Date): CalendarDay {
  const wall = toJakartaWallClock(instant);
  if (wall.hour >= 5 && wall.hour < 10) return { year: wall.year, month: wall.month, day: wall.day };
  return reportingDayFor(instant);
}

/** ISO date label (YYYY-MM-DD) used as the `daily_reports.reporting_day` / summary date column value. */
export function formatCalendarDay(day: CalendarDay): string {
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

export function reportingDayWindow(day: CalendarDay): { start: Date; end: Date } {
  const start = fromJakartaWallClock(day.year, day.month, day.day, 10, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/**
 * 0=Sunday..6=Saturday, via a noon-Jakarta UTC instant — NEVER
 * `Date.getDay()`, which reads the UTC calendar day and is exactly the
 * bug class that already corrupted data once in this project
 * (reprocess-message.ts's date-handling fix, 2026-08-08). Noon-anchoring
 * is the same trick addCalendarDays()/date-tabs.ts's weekday computation
 * already use to sidestep any date-boundary ambiguity.
 */
export function dayOfWeek(day: CalendarDay): number {
  return fromJakartaWallClock(day.year, day.month, day.day, 12).getUTCDay();
}

/** The Monday of the week containing `day` (MASTER_SPEC.md §15: weekly wrap-up runs Monday-Saturday). */
export function mondayOf(day: CalendarDay): CalendarDay {
  const dow = dayOfWeek(day);
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  return addCalendarDays(day, -daysSinceMonday);
}
