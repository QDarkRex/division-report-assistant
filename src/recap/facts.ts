import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { dailyReports, members, reportItems, reportRevisions, workStreams } from "../db/schema.ts";
import { addCalendarDays, dayOfWeek, formatCalendarDay, type CalendarDay } from "../shared/time.ts";

/**
 * Facts for the weekly recap (ADR-0016). Everything here is deterministic
 * and computed by code; the model only sees `items` (with short aliases,
 * never UUIDs) and the registry, and everything it says is checked back
 * against this object (llm.ts).
 */

/** The stream unknown or unplaceable items fall into. Seeded by seed-work-streams-20261123.ts. */
export const FALLBACK_STREAM_ID = "lain-lain";

export interface RecapItem {
  /** "i1".."iN": what the model cites. */
  alias: string;
  itemId: string;
  /** Reporting day, YYYY-MM-DD. */
  day: string;
  member: string;
  kind: "regular" | "overtime";
  activity: string;
  result: string | null;
  obstacle: string | null;
  status: string;
  /** Assignment persisted earlier (previous runs); null when never grouped. */
  workStreamId: string | null;
}

export interface RecapStream {
  streamId: string;
  name: string;
  shortName: string;
  description: string;
}

export interface StreamActivity {
  /** Latest reporting day (YYYY-MM-DD) with an item in the two previous weeks. */
  lastDay: string;
  prevCount: number;
}

export interface WeeklyRecapFacts {
  weekStart: string; // Monday, YYYY-MM-DD
  weekEnd: string; // Sunday
  items: RecapItem[];
  registry: RecapStream[];
  memberCount: number;
  itemCount: number;
  blockedCount: number;
  /** Items in the previous week (by date, not by assignment) and how many were blocked. */
  prevItemCount: number;
  prevBlockedCount: number;
  /** Per stream, from assignments persisted for the two previous weeks. */
  prevActivity: Record<string, StreamActivity>;
}

export const WEEKDAY_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

export function weekdayOf(isoDay: string): number {
  const [y, m, d] = isoDay.split("-").map(Number);
  return dayOfWeek({ year: y!, month: m!, day: d! });
}

interface WeekRow extends Omit<RecapItem, "alias"> {
  createdAt: Date;
}

/** Latest revision per report only; regular and overtime reports both count. */
async function loadWeekRows(db: AppDatabase, from: CalendarDay, to: CalendarDay): Promise<WeekRow[]> {
  const reports = await db
    .select({ reportId: dailyReports.reportId, day: dailyReports.reportingDay, kind: dailyReports.kind, member: members.preferredName })
    .from(dailyReports)
    .innerJoin(members, eq(dailyReports.memberId, members.memberId))
    .where(and(gte(dailyReports.reportingDay, formatCalendarDay(from)), lte(dailyReports.reportingDay, formatCalendarDay(to))));
  if (reports.length === 0) return [];
  const byId = new Map(reports.map((r) => [r.reportId, r]));

  const revisions = await db
    .select({ revisionId: reportRevisions.revisionId, reportId: reportRevisions.reportId, number: reportRevisions.revisionNumber })
    .from(reportRevisions)
    .where(inArray(reportRevisions.reportId, [...byId.keys()]));
  const latest = new Map<string, { revisionId: string; number: number }>();
  for (const rev of revisions) {
    const cur = latest.get(rev.reportId);
    if (!cur || rev.number > cur.number) latest.set(rev.reportId, { revisionId: rev.revisionId, number: rev.number });
  }
  const revisionToReport = new Map([...latest].map(([reportId, v]) => [v.revisionId, reportId]));
  if (revisionToReport.size === 0) return [];

  const items = await db.select().from(reportItems).where(inArray(reportItems.revisionId, [...revisionToReport.keys()]));
  const rows: WeekRow[] = [];
  for (const item of items) {
    const report = byId.get(revisionToReport.get(item.revisionId) ?? "");
    if (!report) continue;
    rows.push({
      itemId: item.itemId,
      day: report.day,
      member: report.member,
      kind: report.kind,
      activity: item.activity,
      result: item.result,
      obstacle: item.obstacle,
      status: item.status,
      workStreamId: item.workStreamId,
      createdAt: item.createdAt,
    });
  }
  return rows.sort((a, b) => a.day.localeCompare(b.day) || a.member.localeCompare(b.member) || a.createdAt.getTime() - b.createdAt.getTime() || a.itemId.localeCompare(b.itemId));
}


export async function buildWeeklyRecapFacts(db: AppDatabase, weekStart: CalendarDay): Promise<WeeklyRecapFacts> {
  const weekEnd = addCalendarDays(weekStart, 6);
  const prev1 = addCalendarDays(weekStart, -7);
  const rows = await loadWeekRows(db, weekStart, weekEnd);
  const prevRows = await loadWeekRows(db, addCalendarDays(weekStart, -14), addCalendarDays(weekStart, -1));

  const items: RecapItem[] = rows.map(({ createdAt: _c, ...r }, i) => ({ alias: `i${i + 1}`, ...r }));

  const prev1Start = formatCalendarDay(prev1);
  const prevActivity: Record<string, StreamActivity> = {};
  let prevItemCount = 0;
  let prevBlockedCount = 0;
  for (const r of prevRows) {
    const inLastWeek = r.day >= prev1Start;
    if (inLastWeek) {
      prevItemCount++;
      if (r.status === "blocked") prevBlockedCount++;
    }
    if (!r.workStreamId) continue;
    const cur = prevActivity[r.workStreamId] ?? { lastDay: r.day, prevCount: 0 };
    if (r.day > cur.lastDay) cur.lastDay = r.day;
    if (inLastWeek) cur.prevCount++;
    prevActivity[r.workStreamId] = cur;
  }

  const registryRows = await db.select().from(workStreams).where(isNull(workStreams.archivedAt)).orderBy(asc(workStreams.streamId));
  return {
    weekStart: formatCalendarDay(weekStart),
    weekEnd: formatCalendarDay(weekEnd),
    items,
    registry: registryRows.map((s) => ({ streamId: s.streamId, name: s.name, shortName: s.shortName, description: s.description })),
    memberCount: new Set(items.map((i) => i.member)).size,
    itemCount: items.length,
    blockedCount: items.filter((i) => i.status === "blocked").length,
    prevItemCount,
    prevBlockedCount,
    prevActivity,
  };
}

export interface StalledStream {
  streamId: string;
  shortName: string;
  lastDay: string;
}

/** Streams with items in either of the two previous weeks and none this week, most recent first. */
export function computeStalled(facts: WeeklyRecapFacts, activeStreamIds: ReadonlySet<string>, names: ReadonlyMap<string, string>): StalledStream[] {
  return Object.entries(facts.prevActivity)
    .filter(([id]) => !activeStreamIds.has(id) && id !== FALLBACK_STREAM_ID)
    .map(([id, a]) => ({ streamId: id, shortName: names.get(id) ?? id, lastDay: a.lastDay }))
    .sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.streamId.localeCompare(b.streamId));
}
