import { and, eq, gte, inArray, isNotNull, lt, ne } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { dailyReports, members, projects, reportItems, reportRevisions, taskEvents, taskObstacles, tasks, weeklySummaries } from "../db/schema.ts";
import { listTasksByStatus } from "../tasks/service.ts";
import { classifyOpenTasksByDeadline } from "./deadline-reminders.ts";
import { addCalendarDays, formatCalendarDay, fromJakartaWallClock, mondayOf, reportingDayFor, type CalendarDay } from "../shared/time.ts";
import { countLeaveDaysInRange, getActiveAvailability } from "../members/availability.ts";
import { isSaturdayOptionalFor } from "../members/attendance.ts";
import type { Task } from "../tasks/types.ts";
import { bulletList, clampMessage, countsLine, dayLabel, joinBlocks, obstacleCategoryLabel, section, statusLabel, taskLabel, titleLine } from "../format/wa.ts";

/**
 * MASTER_SPEC.md §15: provisional wrap-up Saturday 10:15 (Monday-Friday
 * plus Saturday's initial state), final Sunday 10:05 (full week, no
 * WhatsApp send — just an updated Sheets record). Same pure-data function
 * for both, mirroring morning-summary.ts's pattern — the caller decides
 * when to call it and whether to send; this just reports on whatever the
 * week looks like at the moment it's called.
 */
export interface WeeklySummary {
  weekStart: string;
  completedThisWeek: Task[];
  openCounts: { active: number; inProgress: number; blocked: number; stale: number; paused: number };
  stillOverdue: Task[];
  obstaclesRaisedCount: number;
  /**
   * d2 (obstacle categorization): from report_items.obstacleCategory —
   * distinct from obstaclesRaisedCount above, which counts formal
   * task_obstacles records. This is the LLM-classified category on each
   * report item's free-text obstacle mention, aggregated here rather
   * than added to the date tabs (deliberately kept off those — an
   * analysis field, and the owner was already unhappy about tab width;
   * a weekly rollup is where it's actually actionable). "none" is
   * excluded — that means "classified as no obstacle," not an obstacle.
   */
  topObstacleCategories: Array<{ category: string; count: number }>;
  /** `requiredDays` is already net of declared leave; `leaveDays` is carried so the rendering can say WHY it is lower. */
  reportCompliance: Array<{ memberName: string; reportedDays: number; requiredDays: number; leaveDays?: number }>;
  projectsTouched: string[];
}

const WORK_DAYS_PER_WEEK = 6; // Monday-Saturday, §1 "the work schedule is Monday through Saturday"

function weekWindow(weekStart: CalendarDay): { start: Date; end: Date } {
  const start = fromJakartaWallClock(weekStart.year, weekStart.month, weekStart.day, 0, 0, 0, 0);
  const end = fromJakartaWallClock(weekStart.year, weekStart.month, weekStart.day + 7, 0, 0, 0, 0);
  return { start, end };
}

export async function buildWeeklySummary(db: AppDatabase, now: Date = new Date()): Promise<WeeklySummary> {
  const weekStart = mondayOf(reportingDayFor(now));
  const { start, end } = weekWindow(weekStart);

  const openStatuses = ["active", "in_progress", "blocked", "stale", "paused"] as const;
  const [completedEvents, openListsByStatus, deadlineGroups, obstacleRows, reportRows, activeMembers, obstacleCategoryRows] = await Promise.all([
    db
      .select({ taskId: taskEvents.taskId })
      .from(taskEvents)
      .where(and(eq(taskEvents.toStatus, "done"), gte(taskEvents.createdAt, start), lt(taskEvents.createdAt, end))),
    Promise.all(openStatuses.map((status) => listTasksByStatus(db, status))),
    classifyOpenTasksByDeadline(db, now),
    db.select().from(taskObstacles).where(and(gte(taskObstacles.createdAt, start), lt(taskObstacles.createdAt, end))),
    db
      .select({ memberId: dailyReports.memberId, reportingDay: dailyReports.reportingDay })
      .from(dailyReports)
      .where(and(gte(dailyReports.reportingDay, formatCalendarDay(weekStart)), lt(dailyReports.reportingDay, formatCalendarDay(addCalendarDays(weekStart, 7))))),
    db.select().from(members).where(eq(members.membershipStatus, "active")),
    // Windowed by dailyReports.reportingDay, NOT reportItems.createdAt —
    // consistent with reportCompliance's windowing above, and correct for
    // a late-arriving correction: a revision submitted after the week
    // ends but attributed (via reportingDay) to a day inside the week
    // should still count for that week, which createdAt-based windowing
    // would incorrectly miss.
    db
      .select({ obstacleCategory: reportItems.obstacleCategory })
      .from(reportItems)
      .innerJoin(reportRevisions, eq(reportItems.revisionId, reportRevisions.revisionId))
      .innerJoin(dailyReports, eq(reportRevisions.reportId, dailyReports.reportId))
      .where(
        and(
          isNotNull(reportItems.obstacleCategory),
          ne(reportItems.obstacleCategory, "none"),
          gte(dailyReports.reportingDay, formatCalendarDay(weekStart)),
          lt(dailyReports.reportingDay, formatCalendarDay(addCalendarDays(weekStart, 7))),
        ),
      ),
  ]);

  const categoryCounts = new Map<string, number>();
  for (const row of obstacleCategoryRows) {
    if (!row.obstacleCategory) continue;
    categoryCounts.set(row.obstacleCategory, (categoryCounts.get(row.obstacleCategory) ?? 0) + 1);
  }
  const topObstacleCategories = [...categoryCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const completedTaskIds = [...new Set(completedEvents.map((e) => e.taskId))];
  const completedThisWeek = completedTaskIds.length > 0 ? await db.select().from(tasks).where(inArray(tasks.taskId, completedTaskIds)) : [];

  const openByStatus = new Map(openStatuses.map((status, i) => [status, openListsByStatus[i] ?? []]));
  const activeOpen = openByStatus.get("active") ?? [];
  const inProgressOpen = openByStatus.get("in_progress") ?? [];
  const blockedOpen = openByStatus.get("blocked") ?? [];
  const staleOpen = openByStatus.get("stale") ?? [];
  const pausedOpen = openByStatus.get("paused") ?? [];

  const reportedDaysByMemberId = new Map<string, Set<string>>();
  for (const row of reportRows) {
    const set = reportedDaysByMemberId.get(row.memberId) ?? new Set<string>();
    set.add(row.reportingDay);
    reportedDaysByMemberId.set(row.memberId, set);
  }
  // Leave days are subtracted from what the member owed (fixed
  // 2026-08-12): requiredDays was a flat 6 for everyone, so someone on
  // three days' approved cuti showed as "3/6" — visually identical to
  // someone who simply ignored the bot for half the week. §15 forbids
  // per-member performance ranking; publishing an absence as a compliance
  // shortfall is that ranking's worst version, and wrong besides.
  const complianceMembers = activeMembers.filter((m) => m.reportRequired);
  const leaveDaysByMemberId = new Map<string, number>();
  for (const member of complianceMembers) {
    leaveDaysByMemberId.set(
      member.memberId,
      await countLeaveDaysInRange(db, member.memberId, weekStart, addCalendarDays(weekStart, WORK_DAYS_PER_WEEK - 1)),
    );
  }

  // Saturday is only owed by magang (owner, 2026-08-29), so counting a
  // flat six days would score every senior and staff member as one day
  // short every single week — the same misrepresentation the leave
  // subtraction above exists to prevent.
  //
  // Asked as a LEVEL question, not via getAttendanceExpectations: that
  // also reports declared leave, and leaveDays already subtracts those.
  // Using it here made a Saturday cuti count twice — once as a leave day,
  // once as an unowed day — which the existing leave test caught.
  const saturday = addCalendarDays(weekStart, WORK_DAYS_PER_WEEK - 1);
  const saturdayPresenceByMemberId = new Map<string, boolean>();
  for (const member of complianceMembers) {
    const declared = await getActiveAvailability(db, member.memberId, saturday);
    saturdayPresenceByMemberId.set(member.memberId, declared?.kind === "masuk");
  }

  const reportCompliance = complianceMembers.map((m) => {
    const leaveDays = leaveDaysByMemberId.get(m.memberId) ?? 0;
    // Owed if they are magang, or if they explicitly said they were coming in.
    const saturdayOwed = !isSaturdayOptionalFor(m) || saturdayPresenceByMemberId.get(m.memberId) ? 1 : 0;
    const workDays = WORK_DAYS_PER_WEEK - 1 + saturdayOwed;
    return {
      memberName: m.preferredName,
      reportedDays: reportedDaysByMemberId.get(m.memberId)?.size ?? 0,
      // Never negative: a member could in principle declare leave on more
      // days than the work week counts (e.g. including Sunday).
      requiredDays: Math.max(workDays - leaveDays, 0),
      leaveDays,
    };
  });

  const touchedTasks = [...completedThisWeek, ...activeOpen, ...inProgressOpen, ...blockedOpen, ...staleOpen, ...pausedOpen];
  const projectIds = [...new Set(touchedTasks.map((t) => t.projectId).filter((id): id is string => id !== null))];
  const projectRows = projectIds.length > 0 ? await db.select().from(projects).where(inArray(projects.projectId, projectIds)) : [];

  return {
    weekStart: formatCalendarDay(weekStart),
    completedThisWeek,
    openCounts: {
      active: activeOpen.length,
      inProgress: inProgressOpen.length,
      blocked: blockedOpen.length,
      stale: staleOpen.length,
      paused: pausedOpen.length,
    },
    stillOverdue: deadlineGroups.overdue,
    obstaclesRaisedCount: obstacleRows.length,
    topObstacleCategories,
    reportCompliance,
    projectsTouched: projectRows.map((p) => p.name),
  };
}

/**
 * Upserts on weekStart — the provisional (Saturday) and final (Sunday)
 * runs for the same week both land in one row, final overwriting
 * provisional. weekly_summaries_week_start_idx (migration 0002) makes
 * this safe against pg-boss retries inserting a duplicate for the same
 * week.
 */
export async function persistWeeklySummary(db: AppDatabase, summary: WeeklySummary, provisional: boolean, sentAt: Date | null): Promise<void> {
  await db
    .insert(weeklySummaries)
    .values({ weekStart: summary.weekStart, provisional, content: summary, sentAt: sentAt ?? undefined })
    .onConflictDoUpdate({
      target: weeklySummaries.weekStart,
      set: { provisional, content: summary, sentAt: sentAt ?? undefined },
    });
}

export function formatWeeklySummaryText(summary: WeeklySummary): string {
  const open = summary.openCounts;
  const openLine = countsLine([
    [open.inProgress, statusLabel("in_progress").toLowerCase()],
    [open.active, statusLabel("active").toLowerCase()],
    [open.blocked, statusLabel("blocked").toLowerCase()],
    [open.stale, statusLabel("stale").toLowerCase()],
    [open.paused, statusLabel("paused").toLowerCase()],
  ]);
  const allOpenZero = open.inProgress + open.active + open.blocked + open.stale + open.paused === 0;

  const obstacleLines: string[] = [];
  if (summary.obstaclesRaisedCount > 0) obstacleLines.push(`${summary.obstaclesRaisedCount} kendala dilaporkan minggu ini`);
  if (summary.topObstacleCategories.length > 0) {
    const top3 = summary.topObstacleCategories.slice(0, 3);
    obstacleLines.push(`Terbanyak: ${top3.map((c) => `${obstacleCategoryLabel(c.category)} ×${c.count}`).join(" · ")}`);
  }

  const missingCompliance = summary.reportCompliance.filter((r) => r.reportedDays < r.requiredDays);

  return clampMessage(joinBlocks(
    titleLine("📊", "Ringkasan mingguan", `minggu ${dayLabel(summary.weekStart)}`),
    `${summary.completedThisWeek.length} task selesai minggu ini`,
    section("Masih terbuka", [allOpenZero ? "Tidak ada task terbuka" : openLine]),
    summary.stillOverdue.length > 0 &&
      section(`Masih terlambat (${summary.stillOverdue.length})`, bulletList(summary.stillOverdue.map((t) => `⚠️ ${taskLabel(t)}`))),
    obstacleLines.length > 0 && section("Kendala", bulletList(obstacleLines)),
    missingCompliance.length > 0 &&
      section(
        "Kepatuhan lapor",
        bulletList(missingCompliance.map((r) => `${r.memberName} ${r.reportedDays}/${r.requiredDays}${r.leaveDays ? ` (${r.leaveDays} hari izin)` : ""}`), {
          max: 15,
        }),
      ),
    summary.projectsTouched.length > 0 && section("Project", bulletList(summary.projectsTouched)),
  ));
}
