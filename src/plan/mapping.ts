import { addCalendarDays } from "../shared/time.ts";
import { computeMustFinishBefore } from "../tasks/deadline.ts";
import type { TaskStatus } from "../tasks/state-machine.ts";

/**
 * How one row of an external plan spreadsheet becomes a WDH task. These
 * rules were first written inline in
 * src/scripts/import-aerolift-master-plan-20261001.ts (the one-off import
 * of the 49 steps); they live here now so the import script and the
 * continuous sync cannot drift apart. The script imports them back.
 */

/** The fields of a plan row that feed the task's admin note. */
export interface AdminNoteFields {
  id: string;
  priority: string | null;
  start: string | null;
  deadline: string | null;
  dependsOn: string | null;
  output: string | null;
  doneWhen: string | null;
  risk: string | null;
  support: string | null;
  note: string | null;
}

export function adminNoteFor(row: AdminNoteFields): string {
  const span = row.start || row.deadline ? ` · ${row.start ?? "?"} s/d ${row.deadline ?? "?"}` : "";
  const parts = [
    `Master Plan ${row.id}${row.priority ? ` · ${row.priority}` : ""}${span}`,
    row.output ? `Output: ${row.output}` : null,
    row.doneWhen ? `Selesai bila: ${row.doneWhen}` : null,
    row.dependsOn ? `Dependensi: ${row.dependsOn}` : null,
    row.risk ? `Risiko: ${row.risk}` : null,
    row.support ? `Support: ${row.support}` : null,
    row.note ? `Catatan: ${row.note}` : null,
  ];
  return parts.filter((p): p is string => p !== null).join(" | ");
}

/**
 * The plan's deadline is INCLUSIVE — single-day steps have Mulai = Deadline
 * (e.g. 2.01: 25 Sep – 25 Sep). WDH's rule is "deadline N = selesai sebelum
 * N 00:00", so the instant is the start of the day AFTER the plan's
 * deadline, while tasks.deadline_label keeps the plan's own date so the
 * TASKS tab reads the same as the plan.
 */
export function mustFinishBeforeFor(planDeadlineIso: string): Date {
  const [year, month, day] = planDeadlineIso.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`bad plan date "${planDeadlineIso}"`);
  return computeMustFinishBefore(addCalendarDays({ year, month, day }, 1));
}

/**
 * The plan's Status column to a task status. null means "not a status this
 * code knows" — the caller leaves the task's status alone rather than
 * guessing, and the raw text is still kept in plan_items.status_text.
 */
const PLAN_STATUS_TO_TASK: Record<string, TaskStatus> = {
  selesai: "done",
  berjalan: "in_progress",
  "belum mulai": "active",
  blocked: "blocked",
  "menunggu input": "paused",
};

export function taskStatusForPlan(statusText: string | null): TaskStatus | null {
  if (!statusText) return null;
  return PLAN_STATUS_TO_TASK[statusText.trim().replace(/\s+/g, " ").toLowerCase()] ?? null;
}

export function titleFor(area: string, step: string): string {
  return `${area}: ${step}`;
}

export const SOURCE_REFERENCE_PREFIX = "master-plan-";

/** "aerolift", "3.07" -> "master-plan-aerolift:3.07" (tasks.source_reference) */
export function sourceReferenceFor(sourceKey: string, id: string): string {
  return `${SOURCE_REFERENCE_PREFIX}${sourceKey}:${id}`;
}

/**
 * A task whose step left the sheet keeps a source_reference that can never
 * collide with a live one: the ID is likely to be reused by a different step,
 * and several removed tasks may have sat at the same ID. Shape:
 * "master-plan-aerolift:5.03~removed-1a2b3c4d" (first 8 hex of the task id).
 */
export function removedSourceReferenceFor(sourceKey: string, id: string, taskId: string): string {
  return `${sourceReferenceFor(sourceKey, id)}${REMOVED_MARK}-${taskId.slice(0, 8)}`;
}

export const REMOVED_MARK = "~removed";

/** "master-plan-aerolift:5.03~removed-1a2b3c4d" -> { sourceKey: "aerolift", id: "5.03", removed: true }; null when it is not a plan reference. */
export function parsePlanSourceReference(sourceReference: string | null | undefined): { sourceKey: string; id: string; removed: boolean } | null {
  if (!isPlanTask(sourceReference)) return null;
  const rest = (sourceReference as string).slice(SOURCE_REFERENCE_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const tail = rest.slice(colon + 1);
  const mark = tail.indexOf(REMOVED_MARK);
  return { sourceKey: rest.slice(0, colon), id: mark >= 0 ? tail.slice(0, mark) : tail, removed: mark >= 0 };
}

/** "aerolift", "3.07" -> "aerolift:3.07" (plan_items.plan_ref) */
export function planRefFor(sourceKey: string, id: string): string {
  return `${sourceKey}:${id}`;
}

/** Tasks that follow an external plan are marked by their source_reference. */
export function isPlanTask(sourceReference: string | null | undefined): boolean {
  return typeof sourceReference === "string" && sourceReference.startsWith(SOURCE_REFERENCE_PREFIX);
}
