import { and, eq, like, notInArray } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { dailyReports, reportItemFlags, reportItems, reportRevisions, taskContributors, tasks } from "../db/schema.ts";
import {
  clearPendingConfirmation,
  currentItemIds,
  updatePendingReportMatch,
  type ReportMatchItem,
  type ReportMatchPayload,
} from "../queries/confirmation.ts";
import { claimTask, getTask } from "../tasks/service.ts";
import type { Task } from "../tasks/types.ts";
import { CANDIDATE_TASKS_ENABLED, createCandidateTask } from "../tasks/candidates.ts";
import { joinBlocks, titleLine } from "../format/wa.ts";
import {
  FLAG_BLOCKED_VS_PLAN,
  FLAG_DEPENDENCY_OPEN,
  FLAG_DONE_VS_PLAN,
  FLAG_EARLY_START,
  FLAG_LOW_CONFIDENCE,
  FLAG_OTHER_PIC,
  raiseFlag,
  setFlagState,
} from "./flags.ts";
import { loadPlanContext, memberNameOf, planIdOf, raisePlanFlags } from "./matching.ts";
import { parsePlanSourceReference } from "./mapping.ts";
import type { ReportMatchReply } from "./report-match-reply.ts";

/**
 * The reporter's answers to the numbered plan-match list in the report
 * acknowledgment (pending_confirmations kind 'report_match'): "ya"/"bukan"
 * for the whole list or per number, and "3 = 2.08" to point an item at a
 * different plan step. Every function here is deterministic — no LLM.
 *
 * Whatever is answered, a plan task's STATUS is never touched (the plan owns
 * it): linking only sets report_items.task_id, records the member as a
 * contributor, and raises the comparison flags for the admins.
 */

export const REPORT_MATCH_HELP = joinBlocks(
  titleLine("⚠️", "Balasan belum jelas"),
  "Contoh: *@helper ya* · *@helper bukan* · *@helper 2 ya 3 bukan* · *@helper 3 = 2.08*",
);

const CLOSED_TASK_STATUSES = ["done", "cancelled"] as const;

/** Flags that compare a LINKED item with the plan; they stop making sense the moment the link is undone. */
const COMPARISON_FLAG_KINDS = [FLAG_OTHER_PIC, FLAG_DONE_VS_PLAN, FLAG_BLOCKED_VS_PLAN, FLAG_EARLY_START, FLAG_DEPENDENCY_OPEN];

interface ItemContext {
  item: typeof reportItems.$inferSelect;
  revisionId: string;
  reportId: string;
  reportingDay: string;
}

async function loadItem(db: AppDatabase, itemId: string): Promise<ItemContext | null> {
  const [row] = await db
    .select({ item: reportItems, revisionId: reportRevisions.revisionId, reportId: reportRevisions.reportId, reportingDay: dailyReports.reportingDay })
    .from(reportItems)
    .innerJoin(reportRevisions, eq(reportItems.revisionId, reportRevisions.revisionId))
    .innerJoin(dailyReports, eq(reportRevisions.reportId, dailyReports.reportId))
    .where(eq(reportItems.itemId, itemId))
    .limit(1);
  return row ?? null;
}

/** Link an item to a plan task exactly as a high-confidence match would have: task_id, project, contributor, comparison flags. */
async function linkItem(db: AppDatabase, memberId: string, memberName: string, ctx: ItemContext, task: Task): Promise<void> {
  const set: { taskId: string; projectId?: string } = { taskId: task.taskId };
  if (ctx.item.projectId === null && task.projectId) set.projectId = task.projectId;
  await db.update(reportItems).set(set).where(eq(reportItems.itemId, ctx.item.itemId));
  await claimTask(db, task.taskId, memberId);

  const plan = await loadPlanContext(db, task);
  if (plan) {
    await raisePlanFlags(db, plan, {
      itemId: ctx.item.itemId,
      revisionId: ctx.revisionId,
      reportId: ctx.reportId,
      memberId,
      memberName,
      reportingDay: ctx.reportingDay,
      activity: ctx.item.activity,
      status: ctx.item.status,
      obstacle: ctx.item.obstacle,
    });
  }
}

/** Items of this member, in the latest revision of their report, linked to `taskId` — other than `exceptItemId`. */
async function otherLinkedItems(db: AppDatabase, memberId: string, taskId: string, exceptItemId: string) {
  const rows = await db
    .select({ itemId: reportItems.itemId, reportId: reportRevisions.reportId })
    .from(reportItems)
    .innerJoin(reportRevisions, eq(reportItems.revisionId, reportRevisions.revisionId))
    .innerJoin(dailyReports, eq(reportRevisions.reportId, dailyReports.reportId))
    .where(and(eq(dailyReports.memberId, memberId), eq(reportItems.taskId, taskId)));
  const current = await currentItemIds(db, rows.map((r) => r.itemId));
  return rows.filter((r) => r.itemId !== exceptItemId && current.has(r.itemId));
}

/**
 * Undo a link. The member stops being a contributor only if none of their
 * other current items still links the task; the comparison flags that the
 * link raised are closed as 'rejected' only if no other item of the same
 * report still links it (flags are per report + plan task, not per item).
 */
async function unlinkItem(db: AppDatabase, memberId: string, ctx: ItemContext, taskId: string, now: Date): Promise<void> {
  await db.update(reportItems).set({ taskId: null }).where(eq(reportItems.itemId, ctx.item.itemId));
  const others = await otherLinkedItems(db, memberId, taskId, ctx.item.itemId);
  if (others.length === 0) {
    await db.delete(taskContributors).where(and(eq(taskContributors.taskId, taskId), eq(taskContributors.memberId, memberId)));
  }
  if (!others.some((o) => o.reportId === ctx.reportId)) {
    const open = await db
      .select()
      .from(reportItemFlags)
      .where(and(eq(reportItemFlags.reportId, ctx.reportId), eq(reportItemFlags.taskId, taskId), eq(reportItemFlags.state, "open")));
    for (const flag of open) {
      if (COMPARISON_FLAG_KINDS.includes(flag.kind as (typeof COMPARISON_FLAG_KINDS)[number])) await setFlagState(db, flag.flagId, "rejected", now);
    }
  }
}

/** Records the reporter's verdict on a plan match as a low_confidence flag in a terminal state (creating the flag when no question was ever asked). */
async function recordVerdict(
  db: AppDatabase,
  memberId: string,
  ctx: ItemContext,
  taskId: string,
  planRef: string,
  state: "confirmed" | "rejected",
  note: string,
  now: Date,
): Promise<string> {
  const { flag } = await raiseFlag(db, {
    itemId: ctx.item.itemId,
    revisionId: ctx.revisionId,
    reportId: ctx.reportId,
    memberId,
    taskId,
    kind: FLAG_LOW_CONFIDENCE,
    detail: { planRef, planId: planIdOf(planRef), taskId, activity: ctx.item.activity, note },
  });
  await setFlagState(db, flag.flagId, state, now);
  return flag.flagId;
}

/** The one OPEN plan task with this step id ("2.08"), preferring the source the item's current match came from; null when unknown, closed, or ambiguous. */
async function findOpenPlanTask(db: AppDatabase, planId: string, preferSourceKey: string | null): Promise<Task | null> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(like(tasks.sourceReference, `master-plan-%:${planId}`), notInArray(tasks.status, [...CLOSED_TASK_STATUSES])));
  const matches = rows.filter((t) => {
    const parsed = parsePlanSourceReference(t.sourceReference);
    return parsed !== null && !parsed.removed && parsed.id === planId;
  });
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1 && preferSourceKey) {
    const preferred = matches.filter((t) => parsePlanSourceReference(t.sourceReference)?.sourceKey === preferSourceKey);
    if (preferred.length === 1) return preferred[0] ?? null;
  }
  return null;
}

function sourceKeyOf(planRef: string): string | null {
  const colon = planRef.indexOf(":");
  return colon > 0 ? planRef.slice(0, colon) : null;
}

interface ItemResult {
  n: number;
  text: string;
}

/**
 * Applies a parsed reply to the pending report_match and returns the text to
 * send back: one line, one part per number answered, e.g.
 *
 *   ✅ 2 → [1.01] · ❌ 3 tidak terkait · ⏳ masih menunggu: 4
 *
 *  - ya      question -> linked (flag 'confirmed', comparison flags raised);
 *            an already linked item is left alone.
 *  - bukan   question -> flag 'rejected', item stays unlinked and becomes a
 *            candidate task for the admins; linked -> unlinked (contributor
 *            removed only if no other item of the member links the task), a
 *            'rejected' verdict recorded, and likewise a candidate task.
 *  - N = ID  item N -> the OPEN plan task with that id; an unknown or closed
 *            id leaves the item exactly as it was.
 *  - A bare ya / bukan answers every item still in state 'question'.
 *
 * Items not mentioned stay pending. The row is removed once no 'question' is
 * left (corrections of linked items work only while it exists) and is
 * otherwise rewritten WITHOUT restarting its 12-hour clock.
 */
export async function applyReportMatchReply(
  db: AppDatabase,
  memberId: string,
  match: ReportMatchPayload,
  reply: Exclude<ReportMatchReply, { kind: "invalid" }>,
  now: Date,
): Promise<string> {
  const items = new Map<number, ReportMatchItem>(match.items.map((i) => [i.n, { ...i }]));
  const questionsAtStart = [...items.values()].filter((i) => i.state === "question");

  const verbs = new Map<number, "confirm" | "reject">();
  const corrections = new Map<number, string>();
  if (reply.kind === "bulk") {
    if (questionsAtStart.length === 0) {
      return reply.verb === "confirm"
        ? "Semua sudah terkait, tidak ada yang perlu dikonfirmasi."
        : "Tidak ada pertanyaan yang menunggu. Kalau ada yang salah cocok, balas *@helper 1 bukan* atau *@helper 1 = 1.04*.";
    }
    for (const q of questionsAtStart) verbs.set(q.n, reply.verb);
  } else {
    for (const d of reply.decisions) verbs.set(d.n, d.verb);
    for (const c of reply.corrections) corrections.set(c.n, c.planId);
  }

  const memberName = await memberNameOf(db, memberId);
  const results: ItemResult[] = [];
  const removed = new Set<number>();
  let changed = false;

  const numbers = [...new Set([...verbs.keys(), ...corrections.keys()])].sort((a, b) => a - b);
  for (const n of numbers) {
    const entry = items.get(n);
    if (!entry) {
      results.push({ n, text: `⚠️ nomor ${n} tidak ada` });
      continue;
    }
    const shownId = () => planIdOf(entry.planRef);
    const stale = () => {
      removed.add(n);
      changed = true;
      results.push({ n, text: `⚠️ ${n} sudah tidak bisa diproses` });
    };

    const targetId = corrections.get(n);
    if (targetId !== undefined) {
      const task = await findOpenPlanTask(db, targetId, sourceKeyOf(entry.planRef));
      if (!task) {
        results.push({ n, text: `⚠️ ${n}: ID ${targetId} tidak dikenal atau sudah tidak aktif` });
        continue;
      }
      const ctx = await loadItem(db, entry.itemId);
      if (!ctx) {
        stale();
        continue;
      }
      if (task.taskId === entry.taskId && entry.state === "linked") {
        results.push({ n, text: `✅ ${n} → [${shownId()}]` });
        continue;
      }
      const plan = await loadPlanContext(db, task);
      const newRef = plan?.planRef ?? entry.planRef;
      // Release whatever the item was tied to or being asked about.
      if (ctx.item.taskId) {
        await unlinkItem(db, memberId, ctx, ctx.item.taskId, now);
        await recordVerdict(db, memberId, ctx, entry.taskId, entry.planRef, "rejected", "Kaitan ditolak pelapor (dikoreksi ke step lain).", now);
      } else if (entry.flagId) {
        await setFlagState(db, entry.flagId, "rejected", now);
      }
      await linkItem(db, memberId, memberName, ctx, task);
      const flagId = await recordVerdict(db, memberId, ctx, task.taskId, newRef, "confirmed", `Dikoreksi pelapor ke step ${planIdOf(newRef)}.`, now);
      entry.taskId = task.taskId;
      entry.planRef = newRef;
      entry.flagId = flagId;
      entry.state = "linked";
      changed = true;
      results.push({ n, text: `✅ ${n} → [${planIdOf(newRef)}]` });
      continue;
    }

    const verb = verbs.get(n);
    if (verb === "confirm") {
      if (entry.state === "linked") {
        results.push({ n, text: `✅ ${n} → [${shownId()}]` });
        continue;
      }
      const ctx = await loadItem(db, entry.itemId);
      const task = await getTask(db, entry.taskId);
      if (!ctx || !task) {
        stale();
        continue;
      }
      // An item can already be linked if the report was revised and re-matched
      // while the question was open; do not overwrite that answer.
      if (ctx.item.taskId === null) await linkItem(db, memberId, memberName, ctx, task);
      if (entry.flagId) await setFlagState(db, entry.flagId, "confirmed", now);
      entry.state = "linked";
      changed = true;
      results.push({ n, text: `✅ ${n} → [${shownId()}]` });
      continue;
    }

    // reject
    const ctx = await loadItem(db, entry.itemId);
    if (!ctx) {
      stale();
      continue;
    }
    if (entry.state === "question") {
      if (entry.flagId) await setFlagState(db, entry.flagId, "rejected", now);
    } else {
      if (ctx.item.taskId) await unlinkItem(db, memberId, ctx, ctx.item.taskId, now);
      await recordVerdict(db, memberId, ctx, entry.taskId, entry.planRef, "rejected", "Kaitan ditolak pelapor.", now);
    }
    // An unlinked item is what the old flow turned into a candidate task for the
    // admins, and a rejected guess must not make the work vanish from that queue.
    if (CANDIDATE_TASKS_ENABLED && (ctx.item.taskId === null || entry.state === "linked")) {
      await createCandidateTask(db, { reportItemId: ctx.item.itemId, createdByMemberId: memberId, suggestedTitle: ctx.item.activity });
    }
    removed.add(n);
    changed = true;
    results.push({ n, text: `❌ ${n} tidak terkait` });
  }

  const remaining = [...items.values()].filter((i) => !removed.has(i.n)).sort((a, b) => a.n - b.n);
  const stillAsking = remaining.filter((i) => i.state === "question");
  if (changed) {
    if (stillAsking.length === 0) await clearPendingConfirmation(db, memberId);
    else await updatePendingReportMatch(db, memberId, { reportId: match.reportId, items: remaining });
  }

  const parts = results.sort((a, b) => a.n - b.n).map((r) => r.text);
  if (stillAsking.length > 0) parts.push(`⏳ masih menunggu: ${stillAsking.map((i) => i.n).join(", ")}`);
  return parts.join(" · ");
}
