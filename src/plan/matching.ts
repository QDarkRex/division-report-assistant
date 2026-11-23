import { and, eq, inArray, isNull, lte, gte, notInArray, or } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { members, planItems, taskAssignees, tasks } from "../db/schema.ts";
import type { BudgetStatus } from "../llm/budget.ts";
import type { Task } from "../tasks/types.ts";
import type { ReportItemStatus } from "../reports/types.ts";
import { isPlanTask, parsePlanSourceReference } from "./mapping.ts";
import {
  FLAG_BLOCKED_VS_PLAN,
  FLAG_DEPENDENCY_OPEN,
  FLAG_DONE_VS_PLAN,
  FLAG_EARLY_START,
  FLAG_NO_URGENT_WORK,
  FLAG_OTHER_PIC,
  raiseFlag,
  type FlagKind,
} from "./flags.ts";

/**
 * Matching report activities against the external Master Plan.
 *
 * The plan is the source of truth for a plan task's status (owner decision),
 * so nothing here ever changes a task: this module only (1) decides which
 * tasks the model is shown, and (2) compares what a report says with what the
 * plan says and records the disagreements as report_item_flags.
 */

type PlanItemRow = typeof planItems.$inferSelect;

/** Candidate caps, from the owner's brief. */
export const MAX_OWN_CANDIDATES = 25;
export const MAX_WINDOW_CANDIDATES = 15;

/** A task is "open" for matching and nagging purposes unless it has finished or been dropped. */
const CLOSED_STATUSES = ["done", "cancelled"] as const;

/** "aerolift:3.07" -> "3.07"; a bare id passes through. */
export function planIdOf(planRef: string): string {
  const colon = planRef.indexOf(":");
  return colon >= 0 ? planRef.slice(colon + 1) : planRef;
}

/** "master-plan-aerolift:3.07" -> "3.07"; null for a task that is not a plan task. */
export function planIdFromSourceReference(sourceReference: string | null | undefined): string | null {
  return parsePlanSourceReference(sourceReference)?.id ?? null;
}

/** "1.10" sorts after "1.9": plan ids are dotted numbers, not strings. */
function comparePlanIds(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }
  return a.localeCompare(b);
}

function normalizeStatus(statusText: string | null | undefined): string {
  return (statusText ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether a plan row's [start, deadline] window contains the day. A missing side is unbounded; a row with neither has no window at all. */
export function planWindowContains(plan: Pick<PlanItemRow, "startDate" | "deadlineDate">, day: string): boolean {
  if (!plan.startDate && !plan.deadlineDate) return false;
  if (plan.startDate && plan.startDate > day) return false;
  if (plan.deadlineDate && plan.deadlineDate < day) return false;
  return true;
}

// --- candidates for the extraction prompt -------------------------------------

export interface ExtractionCandidate {
  taskId: string;
  title: string;
  /** Plan step id ("3.07"), or null for an ordinary task. */
  planId: string | null;
  /** Who holds it, already redacted: "pengirim" for the reporter, "[MEMBER:id]" for anyone else. */
  pics: string[];
  startDate: string | null;
  deadlineDate: string | null;
  planStatus: string | null;
}

async function assigneesByTask(db: AppDatabase, taskIds: readonly string[]): Promise<Map<string, string[]>> {
  const byTask = new Map<string, string[]>();
  if (taskIds.length === 0) return byTask;
  const rows = await db
    .select({ taskId: taskAssignees.taskId, memberId: taskAssignees.memberId })
    .from(taskAssignees)
    .where(inArray(taskAssignees.taskId, [...taskIds]));
  for (const row of rows) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row.memberId]);
  return byTask;
}

/** Open plan tasks whose window contains `day`, optionally only those assigned to one member. Removed-from-plan rows are skipped. */
export async function listOpenPlanTasksInWindow(
  db: AppDatabase,
  day: string,
  opts: { assigneeId?: string } = {},
): Promise<Array<{ task: Task; plan: PlanItemRow }>> {
  const windowOk = and(
    or(isNull(planItems.startDate), lte(planItems.startDate, day)),
    or(isNull(planItems.deadlineDate), gte(planItems.deadlineDate, day)),
  );
  const base = and(notInArray(tasks.status, [...CLOSED_STATUSES]), isNull(planItems.missingSince), windowOk);

  const rows = opts.assigneeId
    ? await db
        .select({ task: tasks, plan: planItems })
        .from(planItems)
        .innerJoin(tasks, eq(planItems.taskId, tasks.taskId))
        .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.taskId))
        .where(and(base, eq(taskAssignees.memberId, opts.assigneeId)))
    : await db
        .select({ task: tasks, plan: planItems })
        .from(planItems)
        .innerJoin(tasks, eq(planItems.taskId, tasks.taskId))
        .where(base);

  // The SQL treats a row with neither date as in-window; the brief says such a row has no window.
  return rows
    .filter((r) => planWindowContains(r.plan, day))
    .sort((a, b) => (a.plan.deadlineDate ?? "9999").localeCompare(b.plan.deadlineDate ?? "9999") || comparePlanIds(planIdOf(a.plan.planRef), planIdOf(b.plan.planRef)));
}

/**
 * The tasks the model may match a report activity to, in priority order and
 * de-duplicated:
 *
 *  (a) every open task assigned to the sender, plan tasks first (those in
 *      today's window ahead of the rest), at most MAX_OWN_CANDIDATES;
 *  (b) other open plan tasks whose window contains the reporting day —
 *      members help each other, so a report may name a colleague's step —
 *      at most MAX_WINDOW_CANDIDATES;
 *  (c) the general open tasks the pipeline always offered, up to
 *      `generalLimit`. Plan tasks are left out of (c): which ones are worth
 *      showing is decided by (a) and (b), and an arbitrary out-of-window
 *      plan step is only noise.
 *
 * Under the budget soft/hard limit only (a) is sent: the sender's own
 * tasks are what a report is most likely about, and the point of the limit
 * is a smaller prompt.
 */
export async function buildExtractionCandidates(
  db: AppDatabase,
  args: { senderId: string; reportingDay: string; budgetStatus: BudgetStatus; generalLimit: number; generalTasks: readonly Task[] },
): Promise<ExtractionCandidate[]> {
  const { senderId, reportingDay } = args;

  const ownRows = await db
    .select({ task: tasks, plan: planItems })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.taskId))
    .leftJoin(planItems, eq(planItems.taskId, tasks.taskId))
    .where(and(eq(taskAssignees.memberId, senderId), notInArray(tasks.status, [...CLOSED_STATUSES])));

  const rank = (r: { task: Task; plan: PlanItemRow | null }): number => {
    if (!isPlanTask(r.task.sourceReference)) return 2;
    return r.plan && planWindowContains(r.plan, reportingDay) ? 0 : 1;
  };
  const own = ownRows
    .filter((r) => !(r.plan && r.plan.missingSince))
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (a.plan && b.plan) {
        return (a.plan.deadlineDate ?? "9999").localeCompare(b.plan.deadlineDate ?? "9999") || comparePlanIds(planIdOf(a.plan.planRef), planIdOf(b.plan.planRef));
      }
      return a.task.createdAt.getTime() - b.task.createdAt.getTime();
    })
    .slice(0, MAX_OWN_CANDIDATES);

  const chosen: Array<{ task: Task; plan: PlanItemRow | null; own: boolean }> = own.map((r) => ({ ...r, own: true }));
  const seen = new Set(chosen.map((c) => c.task.taskId));

  if (args.budgetStatus === "normal") {
    const inWindow = (await listOpenPlanTasksInWindow(db, reportingDay)).filter((r) => !seen.has(r.task.taskId)).slice(0, MAX_WINDOW_CANDIDATES);
    for (const r of inWindow) {
      chosen.push({ task: r.task, plan: r.plan, own: false });
      seen.add(r.task.taskId);
    }

    let general = 0;
    for (const task of args.generalTasks) {
      if (general >= args.generalLimit) break;
      if (seen.has(task.taskId) || isPlanTask(task.sourceReference)) continue;
      chosen.push({ task, plan: null, own: false });
      seen.add(task.taskId);
      general++;
    }
  }

  const assignees = await assigneesByTask(
    db,
    chosen.filter((c) => c.plan).map((c) => c.task.taskId),
  );
  return chosen.map((c) => ({
    taskId: c.task.taskId,
    title: c.task.title,
    planId: c.plan ? planIdOf(c.plan.planRef) : planIdFromSourceReference(c.task.sourceReference),
    // Member names are redacted from the report text before it leaves for the
    // model (SECURITY_AND_PRIVACY.md §4.2), so a PIC is handed over as the same
    // [MEMBER:id] token a mention of them in the report becomes. That lets the
    // model connect "bantu Bagas" to the step Bagas holds without ever seeing
    // a name. The sender is "pengirim" — shorter, and the point of listing
    // their own tasks first.
    pics: (assignees.get(c.task.taskId) ?? []).map((id) => (id === senderId ? "pengirim" : `[MEMBER:${id}]`)).sort(),
    startDate: c.plan?.startDate ?? null,
    deadlineDate: c.plan?.deadlineDate ?? null,
    planStatus: c.plan?.statusText ?? null,
  }));
}

/** One prompt line. An ordinary task keeps the original "- id: title" shape; a plan task carries its plan context. */
export function formatCandidateLine(c: ExtractionCandidate): string {
  if (!c.planId) return `- ${c.taskId}: ${c.title}`;
  const parts = [`- ${c.taskId} [${c.planId}] ${c.title}`];
  if (c.pics.length > 0) parts.push(`PIC: ${c.pics.join(", ")}`);
  if (c.startDate || c.deadlineDate) parts.push(`jadwal: ${c.startDate ?? "?"} s/d ${c.deadlineDate ?? "?"}`);
  if (c.planStatus) parts.push(`status plan: ${c.planStatus}`);
  return parts.join(" | ");
}

// --- comparing a report item with the plan -------------------------------------

export interface PlanContext {
  task: Task;
  /** Null for a plan task whose plan_items row does not exist (yet). */
  plan: PlanItemRow | null;
  /** The short plan id ("3.07"), for display. */
  planId: string;
  /** The full plan_ref ("aerolift:3.07"): the one form flags store, so every reader of report_item_flags.detail.planRef sees the same thing. */
  planRef: string;
  assigneeIds: string[];
}

/** The plan side of a matched task, or null when it is not a plan task at all. */
export async function loadPlanContext(db: AppDatabase, task: Task): Promise<PlanContext | null> {
  if (!isPlanTask(task.sourceReference)) return null;
  const [plan] = await db.select().from(planItems).where(eq(planItems.taskId, task.taskId)).limit(1);
  const assignees = await assigneesByTask(db, [task.taskId]);
  const planId = plan ? planIdOf(plan.planRef) : planIdFromSourceReference(task.sourceReference);
  const parsed = parsePlanSourceReference(task.sourceReference);
  const resolvedId = planId ?? task.sourceReference ?? task.taskId;
  const planRef = plan ? plan.planRef : parsed ? `${parsed.sourceKey}:${parsed.id}` : resolvedId;
  return { task, plan: plan ?? null, planId: resolvedId, planRef, assigneeIds: assignees.get(task.taskId) ?? [] };
}

/**
 * Plan step ids named in a Dependensi cell: "3.05, 3.06" -> ["3.05","3.06"].
 * Anything that is not a dotted id ("Tahap 1–3", "setelah desain final") is
 * ignored — a free-text dependency cannot be checked, and guessing at it
 * would flag people for nothing.
 */
export function parseDependencyIds(dependsOn: string | null | undefined): string[] {
  if (!dependsOn) return [];
  return [...new Set(dependsOn.match(/\b\d{1,3}\.\d{1,3}\b/g) ?? [])];
}

export interface FlaggedItem {
  itemId: string;
  revisionId: string;
  reportId: string;
  memberId: string;
  memberName: string;
  /** The report's day, YYYY-MM-DD. */
  reportingDay: string;
  activity: string;
  status: ReportItemStatus;
  obstacle: string | null;
}

/**
 * The flags for one report item that is linked to a plan task. The plan row's
 * status_text is compared by meaning (case/spacing), not byte-for-byte, since
 * the sheet is edited by hand.
 */
export async function raisePlanFlags(db: AppDatabase, ctx: PlanContext, item: FlaggedItem): Promise<void> {
  const { plan, planId, planRef, task } = ctx;
  const planStatus = normalizeStatus(plan?.statusText);
  const shownStatus = plan?.statusText?.trim() || "kosong";

  const raise = (kind: FlagKind, note: string, extra: Record<string, unknown> = {}) =>
    raiseFlag(db, {
      itemId: item.itemId,
      revisionId: item.revisionId,
      reportId: item.reportId,
      memberId: item.memberId,
      taskId: task.taskId,
      kind,
      detail: { planRef, planId, activity: item.activity, note, ...extra },
    });

  if (!ctx.assigneeIds.includes(item.memberId)) {
    const pic = plan?.picRaw?.trim();
    await raise(FLAG_OTHER_PIC, `${item.memberName} mengerjakan step ${planId} yang PIC-nya ${pic ? pic : "belum ada di sistem"}.`, { picRaw: pic ?? null });
  }

  if (item.status === "done" && planStatus !== "selesai") {
    await raise(FLAG_DONE_VS_PLAN, `Dilaporkan selesai oleh ${item.memberName}, tapi status di plan masih "${shownStatus}".`, { planStatus: plan?.statusText ?? null });
  }

  const hasObstacle = Boolean(item.obstacle?.trim());
  if ((item.status === "blocked" || hasObstacle) && planStatus !== "blocked") {
    await raise(
      FLAG_BLOCKED_VS_PLAN,
      `${item.memberName} melaporkan kendala${item.obstacle?.trim() ? ` (${item.obstacle.trim()})` : ""}, tapi status di plan "${shownStatus}", bukan Blocked.`,
      { planStatus: plan?.statusText ?? null, obstacle: item.obstacle?.trim() || null },
    );
  }

  if (plan && planStatus === "belum mulai" && plan.startDate && plan.startDate > item.reportingDay) {
    await raise(FLAG_EARLY_START, `Step ${planId} baru dijadwalkan mulai ${plan.startDate}, tapi sudah dikerjakan pada ${item.reportingDay}.`, { startDate: plan.startDate });
  }

  if (plan) {
    const sourceKey = plan.planRef.includes(":") ? plan.planRef.slice(0, plan.planRef.indexOf(":")) : "";
    const depIds = parseDependencyIds(plan.dependsOn).filter((id) => id !== planId);
    if (depIds.length > 0) {
      const deps = await db
        .select({ planRef: planItems.planRef, statusText: planItems.statusText })
        .from(planItems)
        .where(inArray(planItems.planRef, depIds.map((id) => `${sourceKey}:${id}`)));
      const open = deps.filter((d) => normalizeStatus(d.statusText) !== "selesai").map((d) => ({ planRef: planIdOf(d.planRef), statusText: d.statusText }));
      if (open.length > 0) {
        await raise(
          FLAG_DEPENDENCY_OPEN,
          `Step ${planId} bergantung pada ${open.map((d) => `${d.planRef} (${d.statusText?.trim() || "kosong"})`).join(", ")} yang belum Selesai.`,
          { openDependencies: open },
        );
      }
    }
  }
}

/**
 * The "nobody reported on the urgent work" flag: the sender holds plan steps
 * that are due to be worked on today, yet no activity in the report matched
 * any plan task. At most one per report; attached to the report's first item
 * because a flag needs an item to hang on.
 */
export async function raiseNoUrgentWorkFlag(
  db: AppDatabase,
  args: { firstItem: Pick<FlaggedItem, "itemId" | "revisionId" | "reportId" | "memberId" | "memberName" | "reportingDay" | "activity"> },
): Promise<boolean> {
  const { firstItem } = args;
  const open = await listOpenPlanTasksInWindow(db, firstItem.reportingDay, { assigneeId: firstItem.memberId });
  if (open.length === 0) return false;
  const ids = open.map((r) => planIdOf(r.plan.planRef));
  const refs = open.map((r) => r.plan.planRef);
  const { created } = await raiseFlag(db, {
    itemId: firstItem.itemId,
    revisionId: firstItem.revisionId,
    reportId: firstItem.reportId,
    memberId: firstItem.memberId,
    taskId: null,
    kind: FLAG_NO_URGENT_WORK,
    detail: {
      planRef: null,
      activity: firstItem.activity,
      note: `${firstItem.memberName} punya step plan yang jadwalnya hari ini (${ids.join(", ")}), tapi tidak ada aktivitas di laporan yang cocok dengan satu pun.`,
      // Full refs, like every other flag; planIds are the short forms the note and the brief print.
      planRefs: refs,
      planIds: ids,
    },
  });
  return created;
}

/** Display name for a member id, for flag notes written outside the pipeline loop. */
export async function memberNameOf(db: AppDatabase, memberId: string): Promise<string> {
  const [row] = await db.select({ name: members.preferredName }).from(members).where(eq(members.memberId, memberId)).limit(1);
  return row?.name ?? "Anggota";
}
