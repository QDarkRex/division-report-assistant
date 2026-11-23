import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { dailyReports, members, reportItems, reportRevisions } from "../db/schema.ts";
import type { AddReportItemInput, DailyReport, ReportKind, ReportItem, ReportRevision, ReportSummary } from "./types.ts";

/**
 * MASTER_SPEC.md §9.5: corrections append a new revision under the SAME
 * daily_reports row — never a second row for the same member+day (the
 * unique index on daily_reports enforces this). Reuses the existing report
 * if one is already open for this member/day.
 */
export async function getOrCreateDailyReport(
  db: AppDatabase,
  memberId: string,
  reportingDay: string,
  kind: ReportKind = "regular",
): Promise<DailyReport> {
  const [existing] = await db
    .select()
    .from(dailyReports)
    .where(and(eq(dailyReports.memberId, memberId), eq(dailyReports.reportingDay, reportingDay), eq(dailyReports.kind, kind)))
    .limit(1);
  if (existing) return existing;

  // SELECT-then-INSERT is a race, and this group triggers it for real:
  // members send the same report twice seconds apart, and the connector
  // dispatches every message without awaiting the previous one. Two
  // concurrent calls for the same member+day both saw no row and both
  // inserted; one hit the unique index and threw, and the message that
  // threw had already been marked processed, so that report was gone.
  // onConflictDoNothing turns the loser into a no-op, and the re-read below
  // returns the row the winner created.
  const [created] = await db
    .insert(dailyReports)
    .values({ memberId, reportingDay, kind })
    .onConflictDoNothing({ target: [dailyReports.memberId, dailyReports.reportingDay, dailyReports.kind] })
    .returning();
  if (created) return created;

  const [raced] = await db
    .select()
    .from(dailyReports)
    .where(and(eq(dailyReports.memberId, memberId), eq(dailyReports.reportingDay, reportingDay), eq(dailyReports.kind, kind)))
    .limit(1);
  if (!raced) throw new Error("daily report insert returned no row and no existing row was found");
  return raced;
}

export async function getDailyReport(
  db: AppDatabase,
  memberId: string,
  reportingDay: string,
  kind: ReportKind = "regular",
): Promise<DailyReport | null> {
  const [report] = await db
    .select()
    .from(dailyReports)
    .where(and(eq(dailyReports.memberId, memberId), eq(dailyReports.reportingDay, reportingDay), eq(dailyReports.kind, kind)))
    .limit(1);
  return report ?? null;
}

/** §9.5: the original revision is preserved — this only ever inserts, never updates a prior revision. */
export async function addRevision(db: AppDatabase, reportId: string, rawText: string, sourceMessageId?: string): Promise<ReportRevision> {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select()
      .from(reportRevisions)
      .where(eq(reportRevisions.reportId, reportId))
      .orderBy(desc(reportRevisions.revisionNumber))
      .limit(1);
    const nextNumber = (latest?.revisionNumber ?? 0) + 1;

    const [revision] = await tx
      .insert(reportRevisions)
      .values({ reportId, revisionNumber: nextNumber, rawText })
      .returning();
    if (!revision) throw new Error("report revision insert returned no row");

    if (sourceMessageId) {
      await tx.update(dailyReports).set({ sourceMessageId }).where(eq(dailyReports.reportId, reportId));
    }

    return revision;
  });
}

export async function getLatestRevision(db: AppDatabase, reportId: string): Promise<ReportRevision | null> {
  const [revision] = await db
    .select()
    .from(reportRevisions)
    .where(eq(reportRevisions.reportId, reportId))
    .orderBy(desc(reportRevisions.revisionNumber))
    .limit(1);
  return revision ?? null;
}

/** §9.3: each report item extracts to activity/result/obstacle/status, optionally linked to an existing task. */
export async function addReportItem(db: AppDatabase, revisionId: string, input: AddReportItemInput): Promise<ReportItem> {
  const [item] = await db
    .insert(reportItems)
    .values({
      revisionId,
      taskId: input.taskId,
      projectId: input.projectId,
      activity: input.activity,
      result: input.result,
      obstacle: input.obstacle,
      obstacleCategory: input.obstacleCategory,
      status: input.status ?? "unknown",
    })
    .returning();
  if (!item) throw new Error("report item insert returned no row");
  return item;
}

export async function listItemsForRevision(db: AppDatabase, revisionId: string): Promise<ReportItem[]> {
  return db.select().from(reportItems).where(eq(reportItems.revisionId, revisionId));
}

/** §9.6: a "no work today" report is held pending_admin_confirmation — the member is still considered missing until approved. */
export async function markNoActivity(db: AppDatabase, reportId: string): Promise<void> {
  await db.update(dailyReports).set({ noActivity: true, pendingAdminConfirmation: true }).where(eq(dailyReports.reportId, reportId));
}

/**
 * The other direction, and it has to exist: a member who said "tidak ada
 * aktivitas" and then sends real work is CORRECTING themselves, which §9.5
 * explicitly allows. Before 2026-09-08 nothing cleared the flag, so the new
 * revision and its items were stored and then hidden — the date tab checks
 * noActivity before it renders any item, so the corrected report still read
 * "— tidak ada aktivitas —" forever. Found by an external audit tracing the
 * source, and it is the fifth member-data-loses-silently bug in this system,
 * so it gets a guard test rather than a fix alone.
 *
 * pendingAdminConfirmation is cleared with it: that hold exists only to stop
 * an unverified "no work" claim counting as a report, and there is now work.
 */
export async function clearNoActivity(db: AppDatabase, reportId: string): Promise<void> {
  await db
    .update(dailyReports)
    .set({ noActivity: false, pendingAdminConfirmation: false })
    .where(eq(dailyReports.reportId, reportId));
}

export async function approveNoActivityReport(db: AppDatabase, reportId: string): Promise<void> {
  await db.update(dailyReports).set({ pendingAdminConfirmation: false }).where(eq(dailyReports.reportId, reportId));
}

/**
 * §9.7 acknowledgment counts. Deliberately straightforward and testable
 * rather than reverse-engineered from the spec's single prose example
 * (whose category counts don't sum unambiguously): an item counts as a
 * "task update" when it's linked to an existing task, "done" when its
 * status is done.
 */
export function summarizeRevision(items: readonly ReportItem[]): ReportSummary {
  return {
    activityCount: items.length,
    taskUpdateCount: items.filter((item) => item.taskId !== null).length,
    taskDoneCount: items.filter((item) => item.status === "done").length,
  };
}

/**
 * Records overtime start/stop, as the member stated them. Only the fields
 * provided are touched, so a check-in (start) and a later checkout (stop)
 * each set their own without clobbering the other. Bumps nothing else —
 * these live on the overtime report and are pure annotation.
 */
export async function setOvertimeTimes(
  db: AppDatabase,
  reportId: string,
  times: { startText?: string; endText?: string },
): Promise<void> {
  const set: Partial<{ overtimeStartText: string; overtimeEndText: string }> = {};
  if (times.startText !== undefined) set.overtimeStartText = times.startText;
  if (times.endText !== undefined) set.overtimeEndText = times.endText;
  if (Object.keys(set).length === 0) return;
  await db.update(dailyReports).set(set).where(eq(dailyReports.reportId, reportId));
}

/**
 * The overtime report a checkout ("selesai lembur") belongs to: the member's
 * most recent one that is still open (no end time) and was created within the
 * last 18 hours. A checkout after midnight, or at 09:30 after a Friday-evening
 * start, therefore lands on the report the work was filed under rather than on
 * whatever day the clock suggests. Null when there is none.
 */
export const OVERTIME_OPEN_REPORT_WINDOW_MS = 18 * 60 * 60 * 1000;

export async function findOpenOvertimeReport(db: AppDatabase, memberId: string, now: Date): Promise<DailyReport | null> {
  const [report] = await db
    .select()
    .from(dailyReports)
    .where(
      and(
        eq(dailyReports.memberId, memberId),
        eq(dailyReports.kind, "overtime"),
        isNull(dailyReports.overtimeEndText),
        gte(dailyReports.createdAt, new Date(now.getTime() - OVERTIME_OPEN_REPORT_WINDOW_MS)),
      ),
    )
    .orderBy(desc(dailyReports.createdAt))
    .limit(1);
  return report ?? null;
}

/** Members with an overtime report for a reporting day, for the "siapa yang lembur" query. */
export async function listOvertimeReporters(
  db: AppDatabase,
  reportingDay: string,
): Promise<Array<{ preferredName: string; startText: string | null; endText: string | null }>> {
  const rows = await db
    .select({
      preferredName: members.preferredName,
      startText: dailyReports.overtimeStartText,
      endText: dailyReports.overtimeEndText,
      createdAt: dailyReports.createdAt,
    })
    .from(dailyReports)
    .innerJoin(members, eq(dailyReports.memberId, members.memberId))
    .where(and(eq(dailyReports.reportingDay, reportingDay), eq(dailyReports.kind, "overtime")))
    .orderBy(dailyReports.createdAt);
  return rows.map((r) => ({ preferredName: r.preferredName, startText: r.startText, endText: r.endText }));
}
