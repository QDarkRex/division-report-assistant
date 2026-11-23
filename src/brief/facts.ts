import { and, desc, eq, gt, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import {
  dailyReports,
  dailySummaries,
  members,
  planItemChanges,
  planItems,
  projects,
  reportItemFlags,
  reportItems,
  reportRevisions,
  taskAssignees,
  tasks,
} from "../db/schema.ts";
import { listMembersOnLeave } from "../members/availability.ts";
import { redactStructuredIdentifiers } from "../llm/redaction.ts";
import { isPlanTask } from "../plan/mapping.ts";
import {
  addCalendarDays,
  calendarDayDiff,
  calendarDayOf,
  dayOfWeek,
  formatCalendarDay,
  fromJakartaWallClock,
  reportingDayFor,
  type CalendarDay,
} from "../shared/time.ts";
import { lastFinishDay } from "../tasks/deadline.ts";
import { buildMorningSummary } from "../jobs/morning-summary.ts";
import { dayLabel } from "../format/wa.ts";

/**
 * Everything the 08:00 brief says about the world, gathered
 * deterministically and in one JSON-serializable object. The renderer
 * (render.ts) prints numbers and lists from here and nowhere else; the LLM
 * (llm.ts) reads this same object and may only point back at it. Nothing in
 * this file calls a model.
 *
 * "Plan" means the tasks mirrored from an external plan spreadsheet
 * (src/plan/): plan_items is the plan's own record and is what progress,
 * status and ownership are read from; the matching task row supplies the
 * deadline instant and the assignees.
 */

/** How far back "since the previous brief" can reach when the previous brief is old or missing. */
const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** A plan task with a stated risk is worth a line once its deadline is this close. */
const RISK_HORIZON_DAYS = 3;
const REPORTING_DAY_LOOKBACK = 7;
const QUIET_REPORTING_DAYS = 2;

const TITLE_MAX = 60;
const TEXT_MAX = 200;

/** One plan step, as every list in the facts refers to it. */
export interface BriefPlanRef {
  /** Full plan_ref, e.g. "aerolift:3.07". The only identifier the LLM may cite. */
  planRef: string;
  /** The step id on its own, e.g. "3.07" — what people say out loud. */
  id: string;
  title: string;
  /** Assignee names, or the plan's own PIC text when it matched nobody. */
  pic: string[];
}

export interface BriefOverdueItem extends BriefPlanRef {
  daysLate: number;
  statusText: string | null;
  progressPct: number | null;
}

export interface BriefDueItem extends BriefPlanRef {
  statusText: string | null;
  progressPct: number | null;
}

export interface BriefAreaProgress {
  area: string;
  items: number;
  progressPct: number;
}

export interface BriefPlanFacts {
  projectName: string;
  itemCount: number;
  overallProgressPct: number;
  /** plan_items.status_text → how many steps; "(kosong)" when the plan left it blank. */
  statusCounts: Record<string, number>;
  areas: BriefAreaProgress[];
  overdue: BriefOverdueItem[];
  dueToday: BriefDueItem[];
  dueTomorrow: BriefDueItem[];
  startingToday: BriefDueItem[];
  /** planRef → "step title", for every step the facts mention; lets the renderer label an LLM-cited ref without trusting the LLM's wording. */
  labels: Record<string, string>;
}

export interface BriefPlanChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** Human-readable, Indonesian: "Berjalan → Selesai", "progress 50% → 100%". */
  text: string;
}

export interface BriefPlanChangeGroup {
  planRef: string;
  id: string;
  /** The step's text (plan_items.step, clipped), so a line stays meaningful when the ID is reused or the step is gone. Null when unknown. */
  title?: string | null;
  /** The task the changes belong to. IDs are reused, so the ref alone does not say which step changed. */
  taskId?: string | null;
  /** The step's previous ID when it was renumbered in the window, else null. */
  oldId?: string | null;
  changes: BriefPlanChange[];
}

export interface BriefReportBlocker {
  member: string;
  activity: string;
  obstacle: string | null;
  /** obstacle_category as stored, null when unclassified. */
  category: string | null;
  itemStatus: string;
  planRef: string | null;
}

export interface BriefPlanBlocked extends BriefPlanRef {
  daysLeft: number | null;
  risk: string | null;
  support: string | null;
  dependsOn: string | null;
  note: string | null;
}

export interface BriefPlanRisk extends BriefPlanRef {
  daysLeft: number;
  statusText: string | null;
  risk: string;
  support: string | null;
}

export interface BriefBlockerFacts {
  /** The reporting day the report blockers come from (YYYY-MM-DD), null when no reports exist lately. */
  reportingDay: string | null;
  fromReports: BriefReportBlocker[];
  planBlocked: BriefPlanBlocked[];
  /** Steps due within RISK_HORIZON_DAYS (or already late) that carry a stated risk and are not already listed as blocked. */
  riskDueSoon: BriefPlanRisk[];
}

export interface BriefFlag {
  /** Plain string — the producer of report_item_flags owns the vocabulary; render.ts labels the ones it knows. */
  kind: string;
  member: string;
  planRef: string | null;
  /** In-window plan ids a flag is about, for no_urgent_work ("3.07", "3.08"); empty for the other kinds. */
  planIds?: string[];
  /** The plan's current status text for planRef, for "reported done, plan still X" style flags. */
  planStatus: string | null;
  activity: string | null;
  note: string | null;
}

export interface BriefQuietItem extends BriefPlanRef {
  statusText: string | null;
}

export interface BriefGeneralFacts {
  /** Counts cover tasks that do NOT come from a plan; plan tasks are in `plan`. */
  active: number;
  overdue: number;
  dueToday: number;
  blocked: number;
  completedYesterday: number;
  onLeaveToday: string[];
}

export interface MorningBriefFacts {
  /** The instant the facts describe, ISO. */
  generatedAt: string;
  /** Jakarta calendar day, YYYY-MM-DD. */
  today: string;
  /** Start of the "since the previous brief" window, ISO. */
  since: string;
  sinceSource: "previous_brief" | "default";
  plan: BriefPlanFacts | null;
  planChanges: BriefPlanChangeGroup[];
  blockers: BriefBlockerFacts;
  flags: BriefFlag[];
  quiet: BriefQuietItem[];
  general: BriefGeneralFacts;
  /** Every member name that appears anywhere above — the only PIC names the LLM may cite. */
  memberNames: string[];
}

// --- small helpers ------------------------------------------------------

function parseIsoDay(value: string | null | undefined): CalendarDay | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Free text from the sheet or from members: no phone numbers, JIDs or bare @-mentions, one line, bounded. */
function cleanText(text: string | null | undefined, max = TEXT_MAX): string | null {
  if (!text) return null;
  const redacted = redactStructuredIdentifiers(text)
    .text.replace(/\[(?:PHONE|JID)_REDACTED\]/g, "[nomor]")
    .replace(/@\d{8,20}\b/g, "@[mention]");
  const oneLine = redacted.replace(/\s+/g, " ").trim();
  return oneLine.length > 0 ? clip(oneLine, max) : null;
}

const BLANK_MARKERS = new Set(["-", "–", "—", "n/a", "na", "none", "nihil", "tidak ada", "tdk ada", "belum ada", "kosong"]);

/** "Risiko: -" in a plan cell means no risk, not a risk called "-". */
function meaningful(text: string | null | undefined, max = TEXT_MAX): string | null {
  const cleaned = cleanText(text, max);
  if (cleaned === null) return null;
  return BLANK_MARKERS.has(cleaned.toLowerCase().replace(/\.$/, "")) ? null : cleaned;
}

function idOf(planRef: string): string {
  const colon = planRef.indexOf(":");
  return colon >= 0 ? planRef.slice(colon + 1) : planRef;
}

function normStatus(statusText: string | null): string {
  return (statusText ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// --- the window "since the previous brief" -------------------------------

/**
 * Where "what changed since yesterday" starts. The previous brief's own send
 * time when one was persisted (so a skipped day or a late run neither loses
 * nor repeats changes); otherwise 24 hours back, or Saturday 08:00 on a
 * Monday, because no brief goes out on Sunday and the plan can change over
 * the weekend. Never further back than a week.
 */
export async function resolveBriefSince(
  db: AppDatabase,
  now: Date,
): Promise<{ since: Date; source: "previous_brief" | "default" }> {
  const today = calendarDayOf(now);
  const [previous] = await db
    .select({ sentAt: dailySummaries.sentAt })
    .from(dailySummaries)
    .where(and(lt(dailySummaries.summaryDay, formatCalendarDay(today)), isNotNull(dailySummaries.sentAt)))
    .orderBy(desc(dailySummaries.summaryDay))
    .limit(1);

  const floor = new Date(now.getTime() - MAX_LOOKBACK_MS);
  if (previous?.sentAt && previous.sentAt.getTime() < now.getTime()) {
    return { since: previous.sentAt.getTime() < floor.getTime() ? floor : previous.sentAt, source: "previous_brief" };
  }
  if (dayOfWeek(today) === 1) {
    const saturday = addCalendarDays(today, -2);
    return { since: fromJakartaWallClock(saturday.year, saturday.month, saturday.day, 8, 0, 0, 0), source: "default" };
  }
  return { since: new Date(now.getTime() - FALLBACK_LOOKBACK_MS), source: "default" };
}

// --- plan changes ---------------------------------------------------------

const CHANGE_FIELD_ORDER = ["added", "reappeared", "renumbered", "removed", "status", "progress", "deadline", "start", "pic", "title", "pic_unresolved"];

function dayText(value: string | null): string {
  return value ? dayLabel(value) : "-";
}

/** One plan_item_changes row as a short Indonesian phrase. Exported for tests. */
export function describePlanChange(field: string, oldValue: string | null, newValue: string | null): string {
  const o = oldValue ?? "-";
  const n = newValue ?? "-";
  switch (field) {
    case "status":
      return `${o} → ${n}`;
    case "progress":
      return `progress ${o} → ${n}`;
    case "deadline":
      return `deadline ${dayText(oldValue)} → ${dayText(newValue)}`;
    case "start":
      return `mulai ${dayText(oldValue)} → ${dayText(newValue)}`;
    case "pic":
      return `PIC ${o} → ${n}`;
    case "title":
      return `judul diubah menjadi "${clip(n, 50)}"`;
    case "added":
      return "langkah baru ditambahkan";
    case "removed":
      return "dihapus dari plan";
    case "reappeared":
      return "muncul kembali di plan";
    case "renumbered":
      return `nomor berubah [${o}] → [${n}]`;
    case "pic_unresolved":
      return `PIC "${n}" belum dikenali`;
    default:
      return `${field}: ${o} → ${n}`;
  }
}

async function listPlanChanges(db: AppDatabase, since: Date, now: Date): Promise<BriefPlanChangeGroup[]> {
  const rows = await db
    .select()
    .from(planItemChanges)
    .where(and(gt(planItemChanges.detectedAt, since), lte(planItemChanges.detectedAt, now)))
    .orderBy(planItemChanges.detectedAt);

  // Grouped by (ref, task): the supervisor reuses IDs, so "5.05 removed" and "5.05 added" in one
  // window are two different steps and must not be merged into one line.
  const groups = new Map<string, { planRef: string; taskId: string | null; changes: BriefPlanChange[] }>();
  for (const row of rows) {
    const key = `${row.planRef}|${row.taskId ?? ""}`;
    const group = groups.get(key) ?? { planRef: row.planRef, taskId: row.taskId, changes: [] };
    group.changes.push({
      field: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      text: describePlanChange(row.field, cleanText(row.oldValue, 80), cleanText(row.newValue, 80)),
    });
    groups.set(key, group);
  }

  const taskIds = [...new Set([...groups.values()].map((g) => g.taskId).filter((id): id is string => id !== null))];
  const stepByTask = new Map<string, string>();
  if (taskIds.length > 0) {
    for (const item of await db.select({ taskId: planItems.taskId, step: planItems.step }).from(planItems).where(inArray(planItems.taskId, taskIds))) {
      stepByTask.set(item.taskId, item.step);
    }
  }

  const orderOf = (field: string) => {
    const i = CHANGE_FIELD_ORDER.indexOf(field);
    return i === -1 ? CHANGE_FIELD_ORDER.length : i;
  };
  const isRemoval = (g: BriefPlanChangeGroup) => g.changes.some((c) => c.field === "removed");
  return [...groups.values()]
    .map((g): BriefPlanChangeGroup => {
      const step = g.taskId ? stepByTask.get(g.taskId) : undefined;
      // Without a plan_items row (should not happen), fall back to the title the change itself carried.
      const carried = g.changes.find((c) => c.field === "added" || c.field === "removed");
      const carriedTitle = carried ? (carried.newValue ?? carried.oldValue) : null;
      const afterColon = carriedTitle && carriedTitle.includes(": ") ? carriedTitle.slice(carriedTitle.indexOf(": ") + 2) : carriedTitle;
      const title = step ?? afterColon;
      return {
        planRef: g.planRef,
        id: idOf(g.planRef),
        title: title ? (cleanText(title, TITLE_MAX) ?? null) : null,
        taskId: g.taskId,
        oldId: g.changes.find((c) => c.field === "renumbered")?.oldValue ?? null,
        changes: g.changes.sort((x, y) => orderOf(x.field) - orderOf(y.field)),
      };
    })
    .sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true }) || Number(isRemoval(x)) - Number(isRemoval(y)));
}

// --- the plan itself ---------------------------------------------------------

interface PlanRow {
  item: typeof planItems.$inferSelect;
  task: typeof tasks.$inferSelect;
  projectName: string | null;
  pic: string[];
  deadlineDay: CalendarDay | null;
  open: boolean;
}

async function loadPlanRows(db: AppDatabase): Promise<PlanRow[]> {
  const rows = await db
    .select({ item: planItems, task: tasks, projectName: projects.name })
    .from(planItems)
    .innerJoin(tasks, eq(planItems.taskId, tasks.taskId))
    .leftJoin(projects, eq(tasks.projectId, projects.projectId));

  const live = rows.filter((r) => r.item.missingSince === null);
  const taskIds = live.map((r) => r.task.taskId);
  const assigneeRows =
    taskIds.length === 0
      ? []
      : await db
          .select({ taskId: taskAssignees.taskId, name: members.preferredName })
          .from(taskAssignees)
          .innerJoin(members, eq(taskAssignees.memberId, members.memberId))
          .where(inArray(taskAssignees.taskId, taskIds));
  const namesByTask = new Map<string, string[]>();
  for (const a of assigneeRows) namesByTask.set(a.taskId, [...(namesByTask.get(a.taskId) ?? []), a.name].sort());

  return live.map((r) => {
    const assigned = namesByTask.get(r.task.taskId) ?? [];
    const raw = cleanText(r.item.picRaw, 60);
    const mustFinishBefore = r.task.mustFinishBefore;
    const deadlineDay = mustFinishBefore ? lastFinishDay(mustFinishBefore) : parseIsoDay(r.item.deadlineDate);
    return {
      item: r.item,
      task: r.task,
      projectName: r.projectName,
      pic: assigned.length > 0 ? assigned : raw ? [raw] : [],
      deadlineDay,
      open: normStatus(r.item.statusText) !== "selesai" && r.task.status !== "done" && r.task.status !== "cancelled",
    };
  });
}

function refOf(row: PlanRow): BriefPlanRef {
  return { planRef: row.item.planRef, id: idOf(row.item.planRef), title: clip(row.item.step, TITLE_MAX), pic: row.pic };
}

/** A step with no progress figure counts as 100 when the plan calls it Selesai and 0 otherwise. */
function effectiveProgress(row: PlanRow): number {
  if (row.item.progressPct !== null) return Math.min(100, Math.max(0, row.item.progressPct));
  return normStatus(row.item.statusText) === "selesai" ? 100 : 0;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

const byPlanId = (a: BriefPlanRef, b: BriefPlanRef) => a.id.localeCompare(b.id, "en", { numeric: true });

function buildPlanFacts(rows: readonly PlanRow[], today: CalendarDay): BriefPlanFacts | null {
  if (rows.length === 0) return null;

  const statusCounts: Record<string, number> = {};
  for (const r of rows) {
    const key = r.item.statusText?.trim() || "(kosong)";
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }

  const areaMap = new Map<string, number[]>();
  for (const r of rows) areaMap.set(r.item.area, [...(areaMap.get(r.item.area) ?? []), effectiveProgress(r)]);
  const areas = [...areaMap.entries()]
    .map(([area, values]) => ({ area, items: values.length, progressPct: mean(values) }))
    .sort((a, b) => a.area.localeCompare(b.area));

  const projectNames = rows.map((r) => r.projectName).filter((n): n is string => !!n);
  const tally = new Map<string, number>();
  for (const n of projectNames) tally.set(n, (tally.get(n) ?? 0) + 1);
  const projectName = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Plan";

  const openRows = rows.filter((r) => r.open);
  const daysLeftOf = (r: PlanRow) => (r.deadlineDay ? calendarDayDiff(r.deadlineDay, today) : null);

  const overdue: BriefOverdueItem[] = openRows
    .filter((r) => (daysLeftOf(r) ?? 0) < 0)
    .map((r) => ({
      ...refOf(r),
      daysLate: -(daysLeftOf(r) as number),
      statusText: r.item.statusText,
      progressPct: r.item.progressPct,
    }))
    .sort((a, b) => b.daysLate - a.daysLate || byPlanId(a, b));

  const dueOn = (delta: number): BriefDueItem[] =>
    openRows
      .filter((r) => daysLeftOf(r) === delta)
      .map((r) => ({ ...refOf(r), statusText: r.item.statusText, progressPct: r.item.progressPct }))
      .sort(byPlanId);

  const todayStr = formatCalendarDay(today);
  const startingToday: BriefDueItem[] = openRows
    .filter((r) => r.item.startDate === todayStr)
    .map((r) => ({ ...refOf(r), statusText: r.item.statusText, progressPct: r.item.progressPct }))
    .sort(byPlanId);

  const labels: Record<string, string> = {};
  for (const r of rows) labels[r.item.planRef] = clip(r.item.step, TITLE_MAX);

  return {
    projectName,
    itemCount: rows.length,
    overallProgressPct: mean(rows.map(effectiveProgress)),
    statusCounts,
    areas,
    overdue,
    dueToday: dueOn(0),
    dueTomorrow: dueOn(1),
    startingToday,
    labels,
  };
}

// --- reports: blockers, flags, who has been heard from -------------------------

interface ReportItemRow {
  item: typeof reportItems.$inferSelect;
  memberName: string;
  reportingDay: string;
}

/** Items of each report's LATEST revision only — an earlier revision was corrected away. */
async function loadRecentReportItems(
  db: AppDatabase,
  currentReportingDay: CalendarDay,
): Promise<{ days: string[]; items: ReportItemRow[] }> {
  const earliest = addCalendarDays(currentReportingDay, -REPORTING_DAY_LOOKBACK);
  const reports = await db
    .select({ reportId: dailyReports.reportId, reportingDay: dailyReports.reportingDay, memberName: members.preferredName })
    .from(dailyReports)
    .innerJoin(members, eq(dailyReports.memberId, members.memberId))
    .where(
      and(
        gte(dailyReports.reportingDay, formatCalendarDay(earliest)),
        lte(dailyReports.reportingDay, formatCalendarDay(currentReportingDay)),
      ),
    );
  if (reports.length === 0) return { days: [], items: [] };

  const days = [...new Set(reports.map((r) => r.reportingDay))].sort().reverse();
  const reportById = new Map(reports.map((r) => [r.reportId, r]));

  const revisions = await db
    .select({ revisionId: reportRevisions.revisionId, reportId: reportRevisions.reportId, number: reportRevisions.revisionNumber })
    .from(reportRevisions)
    .where(inArray(reportRevisions.reportId, [...reportById.keys()]));
  const latest = new Map<string, { revisionId: string; number: number }>();
  for (const rev of revisions) {
    const current = latest.get(rev.reportId);
    if (!current || rev.number > current.number) latest.set(rev.reportId, { revisionId: rev.revisionId, number: rev.number });
  }
  const revisionToReport = new Map([...latest.entries()].map(([reportId, v]) => [v.revisionId, reportId]));
  if (revisionToReport.size === 0) return { days, items: [] };

  const itemRows = await db.select().from(reportItems).where(inArray(reportItems.revisionId, [...revisionToReport.keys()]));
  const items: ReportItemRow[] = [];
  for (const item of itemRows) {
    const report = reportById.get(revisionToReport.get(item.revisionId) ?? "");
    if (report) items.push({ item, memberName: report.memberName, reportingDay: report.reportingDay });
  }
  return { days, items };
}

async function loadOpenFlags(db: AppDatabase, since: Date, now: Date) {
  return db
    .select({ flag: reportItemFlags, memberName: members.preferredName, activity: reportItems.activity })
    .from(reportItemFlags)
    .innerJoin(members, eq(reportItemFlags.memberId, members.memberId))
    .innerJoin(reportItems, eq(reportItemFlags.itemId, reportItems.itemId))
    .where(and(eq(reportItemFlags.state, "open"), gt(reportItemFlags.createdAt, since), lte(reportItemFlags.createdAt, now)))
    .orderBy(reportItemFlags.createdAt);
}

// --- the builder ------------------------------------------------------------------

/**
 * Builds the morning brief's facts for `now`. Deterministic: the same
 * database and the same `now` give the same object. `options.since`
 * overrides the "previous brief" window (tests, previews).
 */
export async function buildMorningBriefFacts(
  db: AppDatabase,
  now: Date = new Date(),
  options: { since?: Date } = {},
): Promise<MorningBriefFacts> {
  const today = calendarDayOf(now);
  const resolved = options.since ? { since: options.since, source: "default" as const } : await resolveBriefSince(db, now);
  const currentReportingDay = reportingDayFor(now);

  const [planRows, planChanges, reportData, flagRows, summary] = await Promise.all([
    loadPlanRows(db),
    listPlanChanges(db, resolved.since, now),
    loadRecentReportItems(db, currentReportingDay),
    loadOpenFlags(db, resolved.since, now),
    buildMorningSummary(db, now),
  ]);

  const plan = buildPlanFacts(planRows, today);
  const planByTask = new Map(planRows.map((r) => [r.task.taskId, r]));
  const planByRef = new Map(planRows.map((r) => [r.item.planRef, r]));
  const todayStr = formatCalendarDay(today);
  const daysLeftOf = (r: PlanRow) => (r.deadlineDay ? calendarDayDiff(r.deadlineDay, today) : null);

  // Blockers ------------------------------------------------------------------
  const latestDay = reportData.days[0] ?? null;
  const fromReports: BriefReportBlocker[] = reportData.items
    .filter((r) => r.reportingDay === latestDay)
    .map((r) => ({ row: r, obstacle: meaningful(r.item.obstacle) }))
    .filter(({ row, obstacle }) => obstacle !== null || row.item.status === "blocked")
    .map(({ row, obstacle }) => ({
      member: row.memberName,
      activity: cleanText(row.item.activity, 120) ?? "",
      obstacle,
      category: row.item.obstacleCategory ?? null,
      itemStatus: row.item.status,
      planRef: row.item.taskId ? (planByTask.get(row.item.taskId)?.item.planRef ?? null) : null,
    }))
    .sort((a, b) => a.member.localeCompare(b.member));

  const openPlanRows = planRows.filter((r) => r.open);
  const planBlocked: BriefPlanBlocked[] = openPlanRows
    .filter((r) => normStatus(r.item.statusText) === "blocked")
    .map((r) => ({
      ...refOf(r),
      daysLeft: daysLeftOf(r),
      risk: meaningful(r.item.risk),
      support: meaningful(r.item.support),
      dependsOn: meaningful(r.item.dependsOn),
      note: meaningful(r.item.note),
    }))
    .sort(byPlanId);

  const riskDueSoon: BriefPlanRisk[] = [];
  for (const r of openPlanRows) {
    const risk = meaningful(r.item.risk);
    const daysLeft = daysLeftOf(r);
    if (risk === null || daysLeft === null || daysLeft > RISK_HORIZON_DAYS) continue;
    if (normStatus(r.item.statusText) === "blocked") continue;
    riskDueSoon.push({ ...refOf(r), daysLeft, statusText: r.item.statusText, risk, support: meaningful(r.item.support) });
  }
  riskDueSoon.sort((a, b) => a.daysLeft - b.daysLeft || byPlanId(a, b));

  // Flags ----------------------------------------------------------------------
  const flags: BriefFlag[] = flagRows.map(({ flag, memberName, activity }) => {
    const detail = (flag.detail ?? {}) as { planRef?: unknown; planIds?: unknown; planRefs?: unknown; note?: unknown; activity?: unknown };
    const rawRef = typeof detail.planRef === "string" ? detail.planRef.trim().replace(/^[|]$/g, "") : "";
    // The producer may write "aerolift:3.07" or just "3.07"; fall back to the flag's own task.
    const idMatches = [...planByRef.keys()].filter((k) => rawRef !== "" && idOf(k) === rawRef);
    const byDetail = planByRef.get(rawRef) ?? (idMatches.length === 1 ? planByRef.get(idMatches[0] as string) : undefined);
    const planRow = byDetail ?? (flag.taskId ? planByTask.get(flag.taskId) : undefined);
    // no_urgent_work lists the in-window steps instead of naming one; "planIds" (short) or "planRefs" (full, or short in older rows).
    const listed = [detail.planIds, detail.planRefs].find((v): v is unknown[] => Array.isArray(v)) ?? [];
    const planIds = [...new Set(listed.filter((v): v is string => typeof v === "string").map((v) => idOf(v.trim())))].filter((v) => v !== "");
    return {
      kind: flag.kind,
      member: memberName,
      // Whichever form the producer wrote ("aerolift:3.07" or "3.07"), the flag shows the step it names even when
      // that step is no longer in the plan.
      planRef: planRow?.item.planRef ?? (rawRef !== "" ? rawRef : null),
      planIds,
      planStatus: planRow?.item.statusText ?? null,
      activity: cleanText(typeof detail.activity === "string" ? detail.activity : activity, 120),
      note: cleanText(typeof detail.note === "string" ? detail.note : null, 120),
    };
  });

  // Quiet plan tasks -----------------------------------------------------------------
  // "Last 2 reporting days" means the two most recent days anybody reported,
  // not the two calendar days before today: on a Monday the calendar days are
  // Sunday and Saturday, and Friday's reports would wrongly not count. With no
  // reports at all there is nothing to compare against, so nothing is "quiet".
  const quietDays = new Set(reportData.days.slice(0, QUIET_REPORTING_DAYS));
  const reportedTaskIds = new Set(
    reportData.items.filter((r) => quietDays.has(r.reportingDay) && r.item.taskId).map((r) => r.item.taskId as string),
  );
  const quiet: BriefQuietItem[] =
    quietDays.size === 0
      ? []
      : openPlanRows
          .filter((r) => {
            if (reportedTaskIds.has(r.task.taskId)) return false;
            if (!r.deadlineDay || calendarDayDiff(r.deadlineDay, today) < 0) return false;
            // A step that starts today has not had a day to be reported on yet.
            return r.item.startDate === null || r.item.startDate < todayStr;
          })
          .map((r) => ({ ...refOf(r), statusText: r.item.statusText }))
          .sort(byPlanId);

  // General (non-plan) -----------------------------------------------------------------
  const nonPlan = (list: readonly { sourceReference: string | null }[]) => list.filter((t) => !isPlanTask(t.sourceReference)).length;
  const onLeaveToday = (await listMembersOnLeave(db, today)).map((m) => m.preferredName).sort();
  const general: BriefGeneralFacts = {
    active: nonPlan(summary.active),
    overdue: nonPlan(summary.overdue),
    dueToday: nonPlan(summary.dueToday),
    blocked: nonPlan(summary.blocked),
    completedYesterday: nonPlan(summary.completedYesterday),
    onLeaveToday,
  };

  const names = new Set<string>(onLeaveToday);
  const addPics = (list: readonly BriefPlanRef[]) => list.forEach((i) => i.pic.forEach((n) => names.add(n)));
  if (plan) {
    addPics(plan.overdue);
    addPics(plan.dueToday);
    addPics(plan.dueTomorrow);
    addPics(plan.startingToday);
  }
  addPics(planBlocked);
  addPics(riskDueSoon);
  addPics(quiet);
  fromReports.forEach((b) => names.add(b.member));
  flags.forEach((f) => names.add(f.member));

  return {
    generatedAt: now.toISOString(),
    today: todayStr,
    since: resolved.since.toISOString(),
    sinceSource: resolved.source === "previous_brief" ? "previous_brief" : "default",
    plan,
    planChanges,
    blockers: { reportingDay: latestDay, fromReports, planBlocked, riskDueSoon },
    flags,
    quiet,
    general,
    memberNames: [...names].filter((n) => n.trim().length > 0).sort(),
  };
}

/** Every plan_ref the facts mention anywhere — what an LLM-cited ref is checked against. */
export function knownPlanRefs(facts: MorningBriefFacts): Set<string> {
  const refs = new Set<string>();
  const add = (list: readonly { planRef: string | null }[]) => list.forEach((i) => i.planRef && refs.add(i.planRef));
  if (facts.plan) {
    add(facts.plan.overdue);
    add(facts.plan.dueToday);
    add(facts.plan.dueTomorrow);
    add(facts.plan.startingToday);
  }
  add(facts.planChanges);
  add(facts.blockers.fromReports);
  add(facts.blockers.planBlocked);
  add(facts.blockers.riskDueSoon);
  add(facts.flags);
  add(facts.quiet);
  return refs;
}

/**
 * Maps whatever a model wrote for a step ("3.07", "[3.07]", "aerolift:3.07")
 * to the full plan_ref in the facts, or null when it names nothing the facts
 * mention. Never invents a match: an id that two plan sources share is
 * ambiguous and resolves to null.
 */
export function resolvePlanRef(raw: string, facts: MorningBriefFacts): string | null {
  const known = knownPlanRefs(facts);
  const text = raw.trim().replace(/^\[|\]$/g, "");
  if (known.has(text)) return text;
  const matches = [...known].filter((ref) => idOf(ref) === text);
  return matches.length === 1 ? (matches[0] as string) : null;
}

/** "3.07" for "aerolift:3.07". */
export function planIdOf(planRef: string): string {
  return idOf(planRef);
}
