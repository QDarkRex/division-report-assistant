import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { reportItemFlags, reportItems } from "../db/schema.ts";

/**
 * The `kind` strings written to report_item_flags by the report pipeline.
 * The morning summary reads these exact values, so they are a contract:
 * changing one is a coordinated change, not a rename.
 */
export const FLAG_LOW_CONFIDENCE = "low_confidence";
export const FLAG_OTHER_PIC = "other_pic";
export const FLAG_DONE_VS_PLAN = "done_vs_plan";
export const FLAG_BLOCKED_VS_PLAN = "blocked_vs_plan";
export const FLAG_EARLY_START = "early_start";
export const FLAG_DEPENDENCY_OPEN = "dependency_open";
export const FLAG_NO_URGENT_WORK = "no_urgent_work";

export const FLAG_KINDS = [
  FLAG_LOW_CONFIDENCE,
  FLAG_OTHER_PIC,
  FLAG_DONE_VS_PLAN,
  FLAG_BLOCKED_VS_PLAN,
  FLAG_EARLY_START,
  FLAG_DEPENDENCY_OPEN,
  FLAG_NO_URGENT_WORK,
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

/** report_item_flags.state values. 'resolved' is for whoever handles the flag later (the morning summary side); this module never sets it. */
export type FlagState = "open" | "confirmed" | "rejected" | "resolved";

/**
 * Every flag's detail carries at least these. `planRef` is the plan task's
 * FULL ref ("aerolift:3.07") — null only on no_urgent_work, which is about
 * the absence of a match and lists the open steps in `planRefs` (full refs)
 * and `planIds` (short ids) instead. Readers must still tolerate the short
 * form ("3.07"), see brief/facts.ts.
 * `note` is a one-line Indonesian explanation written for an admin to read
 * as-is.
 */
export interface FlagDetail {
  planRef: string | null;
  activity: string;
  note: string;
  [extra: string]: unknown;
}

export interface FlagInput {
  itemId: string;
  /** The revision the item belongs to — used to recognise the same flag being raised again by a revised report. */
  revisionId: string;
  reportId: string;
  memberId: string;
  taskId: string | null;
  kind: FlagKind;
  detail: FlagDetail;
}

export type FlagRow = typeof reportItemFlags.$inferSelect;

/**
 * Raises a flag, once.
 *
 * A member who corrects a report sends a whole new revision, and every item
 * in it is a NEW report_items row — so keying on item_id would raise the
 * same "done_vs_plan on 3.07" again for every revision. The flag is
 * therefore identified by what it is about: (report, kind, planRef).
 *
 * - No such flag yet: inserted.
 * - One exists and is still 'open' and was raised from an earlier revision:
 *   it is re-pointed at this revision's item (so an admin reading it sees
 *   the latest wording) and its detail/task refreshed. Not duplicated.
 * - One exists in any other case (same revision raising it twice, or a
 *   human already answered it): left exactly as it is.
 *
 * Flags a revision no longer raises are NOT closed here — whether a
 * superseded flag still matters is for whoever reads them.
 */
export async function raiseFlag(db: AppDatabase, input: FlagInput): Promise<{ flag: FlagRow; created: boolean }> {
  const existing = await db
    .select({ flag: reportItemFlags, itemRevisionId: reportItems.revisionId })
    .from(reportItemFlags)
    .innerJoin(reportItems, eq(reportItemFlags.itemId, reportItems.itemId))
    .where(and(eq(reportItemFlags.reportId, input.reportId), eq(reportItemFlags.kind, input.kind)));
  const match = existing.find((row) => ((row.flag.detail as { planRef?: string | null } | null)?.planRef ?? null) === input.detail.planRef);

  if (match) {
    if (match.flag.state === "open" && match.itemRevisionId !== input.revisionId) {
      const [updated] = await db
        .update(reportItemFlags)
        .set({ itemId: input.itemId, taskId: input.taskId, detail: input.detail })
        .where(eq(reportItemFlags.flagId, match.flag.flagId))
        .returning();
      return { flag: updated ?? match.flag, created: false };
    }
    return { flag: match.flag, created: false };
  }

  const [flag] = await db
    .insert(reportItemFlags)
    .values({
      itemId: input.itemId,
      reportId: input.reportId,
      memberId: input.memberId,
      taskId: input.taskId,
      kind: input.kind,
      detail: input.detail,
    })
    .returning();
  if (!flag) throw new Error("report item flag insert returned no row");
  return { flag, created: true };
}

/** Moves a flag to a terminal state (a member's answer), stamping resolved_at. */
export async function setFlagState(db: AppDatabase, flagId: string, state: Exclude<FlagState, "open">, now: Date): Promise<void> {
  await db.update(reportItemFlags).set({ state, resolvedAt: now }).where(eq(reportItemFlags.flagId, flagId));
}

/** The flag of this kind for this plan task on this report, if one was ever raised (any state). */
export async function findFlag(db: AppDatabase, reportId: string, kind: FlagKind, planRef: string): Promise<FlagRow | null> {
  const rows = await db
    .select()
    .from(reportItemFlags)
    .where(and(eq(reportItemFlags.reportId, reportId), eq(reportItemFlags.kind, kind)));
  return rows.find((row) => ((row.detail as { planRef?: string | null } | null)?.planRef ?? null) === planRef) ?? null;
}
