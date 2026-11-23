import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { members, planItemChanges, planItems, projects, taskAssignees, taskEvents, tasks } from "../db/schema.ts";
import { resolveMembersByNameOrAlias } from "../members/service.ts";
import { confirmProject, createProject } from "../projects/service.ts";
import { normalizeTitle } from "../tasks/service.ts";
import type { Task } from "../tasks/types.ts";
import type { TaskStatus } from "../tasks/state-machine.ts";
import { calendarDayOf, formatCalendarDay } from "../shared/time.ts";
import {
  adminNoteFor,
  mustFinishBeforeFor,
  parsePlanSourceReference,
  planRefFor,
  removedSourceReferenceFor,
  sourceReferenceFor,
  taskStatusForPlan,
  titleFor,
} from "./mapping.ts";
import { planIdOf } from "./matching.ts";
import { matchPlanIdentity, type IdentityEntry, type IdentityPair } from "./identity.ts";
import type { PlanRow } from "./parse.ts";

/**
 * Applies a parsed plan to WDH. The plan spreadsheet is the source of truth
 * for plan tasks (owner decision): its status, PIC and dates overwrite the
 * task's, reports never change a plan task's status, and every change the
 * supervisor makes is RECORDED in plan_item_changes so the morning summary
 * can say what moved.
 *
 * Idempotence is the property everything else leans on. The hourly TASKS
 * export keys off tasks.version, so a sync that touched every task every 15
 * minutes would make every task look edited all day. A row whose plan values
 * are identical to what is already stored writes NOTHING: no task update, no
 * version bump, no event, no plan_items write. (The one exception is a
 * heartbeat that refreshes plan_items.last_seen_at at most once an hour, in
 * a single statement that never touches tasks.)
 *
 * IDENTITY. The sheet's ID is where a step currently sits, not who it is: the
 * supervisor reuses and renumbers IDs (see identity.ts for the real incident).
 * A task is therefore matched to a row by ID *and* step text, a step that
 * moved to another ID is re-keyed (same task_id, so its reports stay
 * attached), and a step that is simply gone is cancelled and marked missing.
 */

export interface SyncPlanOptions {
  /** e.g. "aerolift" — plan_ref prefix "aerolift:" and source_reference prefix "master-plan-aerolift:". */
  sourceKey: string;
  /** The project new plan tasks are created in (created if missing). */
  projectName: string;
  now: Date;
  /** Compute and return everything, persist nothing. */
  dryRun: boolean;
  /**
   * Lifts the "would remove more than 30% of known steps" guard, for the one
   * run where the supervisor really did delete that much. The empty-sheet and
   * under-50% guards cannot be lifted.
   */
  allowMassRemoval?: boolean;
  /** Creator for newly added tasks. Defaults to the creator of the existing plan tasks, then the oldest active admin. */
  creatorMemberId?: string;
}

export type PlanChangeField =
  | "status"
  | "progress"
  | "deadline"
  | "start"
  | "pic"
  | "title"
  | "added"
  | "removed"
  | "reappeared"
  | "renumbered"
  | "pic_unresolved";

export interface PlanChange {
  planRef: string;
  taskId: string | null;
  field: PlanChangeField;
  oldValue: string | null;
  newValue: string | null;
}

export interface SyncPlanResult {
  dryRun: boolean;
  rowsParsed: number;
  /** Plan rows whose task already existed but had no plan_items row yet: recorded as the starting point, no change records. */
  baselined: number;
  added: number;
  removed: number;
  reappeared: number;
  /** Steps that kept their task but changed ID (a "renumbered" change each). */
  renumbered: number;
  /** How the identity matching decided, for logs: moves with their similarity score, and the groups it refused to guess about. */
  identity: {
    moved: Array<{ from: string; to: string; score: number }>;
    reappeared: Array<{ from: string; to: string; score: number }>;
    ambiguous: Array<{ pass: "moved" | "reappeared"; rowIds: string[]; entryIds: string[] }>;
  };
  /** Existing tasks that were actually written. */
  tasksUpdated: number;
  /** Rows that needed no write at all. */
  unchanged: number;
  picUnresolved: number;
  changes: PlanChange[];
}

/** The sync refused to run because the input looks broken (empty or truncated sheet). Nothing was written. */
export class PlanSyncAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanSyncAbortError";
  }
}

/** Thrown inside the transaction to roll a dry run back; carries the result out. Never escapes syncPlan. */
class DryRunRollback extends Error {
  constructor(readonly result: SyncPlanResult) {
    super("dry run rollback");
  }
}

const HEARTBEAT_MS = 60 * 60 * 1000;
const MIN_ROW_RATIO = 0.5;
/** More than this share of the known steps vanishing in ONE run is read as a broken sheet, not a clean-up. */
const MAX_REMOVAL_RATIO = 0.3;
/** Arbitrary constant naming this sync's advisory lock (a cron tick and a manual run must not interleave). */
const ADVISORY_LOCK_KEY = "wdh.plan-sync";

export async function syncPlan(db: AppDatabase, rows: readonly PlanRow[], options: SyncPlanOptions): Promise<SyncPlanResult> {
  try {
    return await db.transaction(async (tx) => {
      const result = await applyPlan(tx as unknown as AppDatabase, rows, options);
      // A dry run executes the very same code against the very same
      // database and then rolls back, instead of a parallel "don't write"
      // code path: the second kind drifts, and a dry run that has quietly
      // stopped matching the real run is worse than none.
      if (options.dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
}

const pct = (progress: number | null): number | null => (progress === null ? null : Math.round(progress * 100));
const pctText = (value: number | null): string | null => (value === null ? null : `${value}%`);

type PlanItemRow = typeof planItems.$inferSelect;

/** One step WDH already knows: a plan_items row, or a plan task that has none yet (adopted from the one-off import). */
interface KnownStep extends IdentityEntry {
  task: Task;
  /** Null for a task imported before plan_items existed. */
  item: PlanItemRow | null;
}

const TASK_TITLE_SPLIT = ": ";

async function applyPlan(db: AppDatabase, rows: readonly PlanRow[], options: SyncPlanOptions): Promise<SyncPlanResult> {
  const { sourceKey, now } = options;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY}))`);

  const existingItems = await db.select().from(planItems).where(like(planItems.planRef, `${sourceKey}:%`));

  const tasksByRef = new Map<string, Task>();
  for (const t of await db.select().from(tasks).where(like(tasks.sourceReference, `master-plan-${sourceKey}:%`))) {
    if (t.sourceReference) tasksByRef.set(t.sourceReference, t);
  }
  const tasksById = new Map([...tasksByRef.values()].map((t) => [t.taskId, t]));
  // A plan_items row is bound to its task by id, whatever the task's
  // source_reference says now; load any the prefix query did not return.
  const missingTaskIds = existingItems.map((i) => i.taskId).filter((id) => !tasksById.has(id));
  if (missingTaskIds.length > 0) {
    for (const t of await db.select().from(tasks).where(inArray(tasks.taskId, missingTaskIds))) tasksById.set(t.taskId, t);
  }
  const assigneesByTask = new Map<string, string[]>();
  const taskIds = [...tasksById.keys()];
  if (taskIds.length > 0) {
    for (const a of await db.select().from(taskAssignees).where(inArray(taskAssignees.taskId, taskIds))) {
      assigneesByTask.set(a.taskId, [...(assigneesByTask.get(a.taskId) ?? []), a.memberId]);
    }
  }

  // --- What WDH knows ---------------------------------------------------------
  const known: KnownStep[] = [];
  const itemTaskIds = new Set<string>();
  for (const item of existingItems) {
    const task = tasksById.get(item.taskId);
    if (!task) continue;
    itemTaskIds.add(item.taskId);
    known.push({ key: item.taskId, id: planIdOf(item.planRef), area: item.area, step: item.step, missing: item.missingSince !== null, task, item });
  }
  // Plan tasks with no plan_items row yet (imported by the one-off script).
  // They are identified by the same rule as everyone else — an imported task
  // is matched by its step text, never trusted by ID alone — so the area and
  // step are read back from its "<area>: <step>" title.
  for (const task of tasksByRef.values()) {
    if (itemTaskIds.has(task.taskId)) continue;
    const parsed = parsePlanSourceReference(task.sourceReference);
    if (!parsed || parsed.removed) continue;
    const split = task.title.indexOf(TASK_TITLE_SPLIT);
    known.push({
      key: task.taskId,
      id: parsed.id,
      area: split >= 0 ? task.title.slice(0, split) : "",
      step: split >= 0 ? task.title.slice(split + TASK_TITLE_SPLIT.length) : task.title,
      missing: false,
      task,
      item: null,
    });
  }

  // --- Guards (before anything is written) ---------------------------------------
  // A sheet that comes back empty or half-empty (a bad range, a permissions
  // blip, someone clearing the table to rebuild it) must not be read as "the
  // supervisor deleted the plan" — that would cancel every step.
  const knownLive = known.filter((k) => !k.missing).length;
  if (rows.length === 0) throw new PlanSyncAbortError("plan sync aborted: the sheet parsed to 0 rows");
  if (knownLive > 0 && rows.length < knownLive * MIN_ROW_RATIO) {
    throw new PlanSyncAbortError(
      `plan sync aborted: sheet parsed to ${rows.length} rows but ${knownLive} are known (under ${MIN_ROW_RATIO * 100}%) — treating as a broken read`,
    );
  }

  const identity = matchPlanIdentity(known, rows);
  if (!options.allowMassRemoval && knownLive > 0 && identity.removed.length > knownLive * MAX_REMOVAL_RATIO) {
    throw new PlanSyncAbortError(
      `plan sync aborted: it would remove ${identity.removed.length} of ${knownLive} known steps (over ${MAX_REMOVAL_RATIO * 100}%) — treating as a broken read: ${identity.removed
        .slice(0, 8)
        .map((e) => e.id)
        .join(", ")}${identity.removed.length > 8 ? ", …" : ""}`,
    );
  }

  const result: SyncPlanResult = {
    dryRun: options.dryRun,
    rowsParsed: rows.length,
    baselined: 0,
    added: 0,
    removed: 0,
    reappeared: 0,
    renumbered: 0,
    identity: {
      moved: identity.moved.map((p) => ({ from: p.entry.id, to: p.row.id, score: p.score })),
      reappeared: identity.reappeared.map((p) => ({ from: p.entry.id, to: p.row.id, score: p.score })),
      ambiguous: identity.ambiguous,
    },
    tasksUpdated: 0,
    unchanged: 0,
    picUnresolved: 0,
    changes: [],
  };
  const changes: PlanChange[] = result.changes;
  const todayLabel = formatCalendarDay(calendarDayOf(now));

  // --- PIC resolution -------------------------------------------------------
  // One ACTIVE member or nothing. A guess here assigns someone else's work to
  // the wrong person, and the plan has no way to say "I meant the other one".
  const picCache = new Map<string, string | null>();
  async function resolvePic(raw: string): Promise<string | null> {
    if (picCache.has(raw)) return picCache.get(raw) ?? null;
    const active = async (name: string) => (await resolveMembersByNameOrAlias(db, name)).filter((m) => m.membershipStatus === "active");
    let found: string | null = null;
    const full = await active(raw);
    if (full.length === 1) {
      found = full[0]?.memberId ?? null;
    } else if (full.length === 0) {
      const first = raw.split(/\s+/)[0];
      if (first && first !== raw) {
        const byFirst = await active(first);
        if (byFirst.length === 1) found = byFirst[0]?.memberId ?? null;
      }
    }
    picCache.set(raw, found);
    return found;
  }

  let projectIdCache: string | undefined;
  let creatorCache: string | undefined;
  async function creator(): Promise<string> {
    if (creatorCache) return creatorCache;
    let id = options.creatorMemberId ?? [...tasksByRef.values()][0]?.createdByMemberId;
    if (!id) {
      const [admin] = await db
        .select({ id: members.memberId })
        .from(members)
        .where(and(eq(members.role, "admin"), eq(members.membershipStatus, "active")))
        .orderBy(asc(members.createdAt))
        .limit(1);
      id = admin?.id;
    }
    if (!id) throw new Error("plan sync needs a creator for new tasks but found no plan task or active admin to take it from");
    creatorCache = id;
    return id;
  }
  async function projectId(): Promise<string> {
    if (projectIdCache) return projectIdCache;
    const [existing] = await db.select().from(projects).where(eq(projects.name, options.projectName)).limit(1);
    if (existing) {
      projectIdCache = existing.projectId;
    } else {
      const created = await createProject(db, { name: options.projectName, createdByMemberId: await creator() });
      await confirmProject(db, created.projectId);
      projectIdCache = created.projectId;
    }
    return projectIdCache;
  }

  async function recordPicUnresolved(planRef: string, taskId: string | null, pic: string) {
    const [already] = await db
      .select({ id: planItemChanges.changeId })
      .from(planItemChanges)
      .where(and(eq(planItemChanges.planRef, planRef), eq(planItemChanges.field, "pic_unresolved"), eq(planItemChanges.newValue, pic)))
      .limit(1);
    if (already) return;
    changes.push({ planRef, taskId, field: "pic_unresolved", oldValue: null, newValue: pic });
    result.picUnresolved++;
  }

  // --- Phase 0: take every moving step off its ID --------------------------------
  // IDs get swapped (A -> B while B -> C). plan_ref is unique among live rows,
  // so each mover parks on a temporary ref first; the row loop below then gives
  // every mover its final ref, by which time nobody else holds it.
  for (const pair of identity.moved) {
    if (pair.entry.item) {
      await db.update(planItems).set({ planRef: `~moving:${pair.entry.key}` }).where(eq(planItems.taskId, pair.entry.key));
    }
  }

  // --- Phase 1: steps the sheet no longer has -------------------------------------
  // The task is cancelled (with an event) so it drops out of deadline
  // reminders and overdue lists, and its source_reference moves out of the
  // way because the ID will likely be reused. If the step comes back it is
  // restored from the plan. The owner sees `removed` in the morning brief.
  for (const entry of identity.removed) {
    const oldRef = planRefFor(sourceKey, entry.id);
    if (entry.item) {
      await db.update(planItems).set({ missingSince: now, updatedAt: now }).where(eq(planItems.taskId, entry.key));
    } else {
      await db.insert(planItems).values({
        planRef: oldRef,
        taskId: entry.key,
        area: entry.area,
        step: entry.step,
        lastSeenAt: now,
        missingSince: now,
        updatedAt: now,
      });
    }
    await db
      .update(tasks)
      .set({
        status: "cancelled",
        sourceReference: removedSourceReferenceFor(sourceKey, entry.id, entry.key),
        updatedAt: now,
        version: sql`${tasks.version} + 1`,
      })
      .where(eq(tasks.taskId, entry.key));
    await db.insert(taskEvents).values({
      taskId: entry.key,
      eventType: "plan_removed",
      fromStatus: entry.task.status,
      toStatus: "cancelled",
      detail: { planRef: oldRef, previousSourceReference: entry.task.sourceReference },
    });
    changes.push({ planRef: oldRef, taskId: entry.key, field: "removed", oldValue: titleFor(entry.area, entry.step), newValue: null });
    result.removed++;
  }

  // --- Phase 2: every row in the sheet ---------------------------------------------
  type Assigned = { entry: KnownStep; pair: IdentityPair<KnownStep, PlanRow>; kind: "kept" | "moved" | "reappeared" };
  const assignedByRow = new Map<PlanRow, Assigned>();
  for (const pair of identity.kept) assignedByRow.set(pair.row, { entry: pair.entry, pair, kind: "kept" });
  for (const pair of identity.moved) assignedByRow.set(pair.row, { entry: pair.entry, pair, kind: "moved" });
  for (const pair of identity.reappeared) assignedByRow.set(pair.row, { entry: pair.entry, pair, kind: "reappeared" });

  const heartbeatTaskIds: string[] = [];

  for (const row of rows) {
    const planRef = planRefFor(sourceKey, row.id);
    const sourceReference = sourceReferenceFor(sourceKey, row.id);

    const assigned = assignedByRow.get(row);
    const item = assigned?.entry.item ?? null;
    const task = assigned?.entry.task;

    const title = titleFor(row.area, row.step);
    const progressPct = pct(row.progress);
    const targetStatus = taskStatusForPlan(row.statusText);
    const adminNote = adminNoteFor(row);
    const picMemberId = row.pic ? await resolvePic(row.pic) : null;

    const itemValues = {
      area: row.area,
      step: row.step,
      picRaw: row.pic,
      priority: row.priority,
      startDate: row.start,
      deadlineDate: row.deadline,
      statusText: row.statusText,
      progressPct,
      dependsOn: row.dependsOn,
      output: row.output,
      doneWhen: row.doneWhen,
      risk: row.risk,
      support: row.support,
      note: row.note,
    };

    // --- A step the plan has that WDH has never seen: create its task. -------
    if (!assigned || !task) {
      const status: TaskStatus = targetStatus ?? "active";
      const [created] = await db
        .insert(tasks)
        .values({
          title,
          normalizedTitle: normalizeTitle(title),
          projectId: await projectId(),
          status,
          createdByMemberId: await creator(),
          sourceReference,
          scheduledFor: row.start,
          deadlineLabel: row.deadline,
          mustFinishBefore: row.deadline ? mustFinishBeforeFor(row.deadline) : null,
          adminNote,
          latestUpdate: progressPct === null ? null : `Progress ${progressPct}% (plan, ${todayLabel})`,
        })
        .returning();
      if (!created) throw new Error("task insert returned no row");
      if (picMemberId) await db.insert(taskAssignees).values({ taskId: created.taskId, memberId: picMemberId });
      await db.insert(taskEvents).values({
        taskId: created.taskId,
        eventType: "plan_sync",
        toStatus: status,
        detail: { planRef, changedFields: ["created"] },
      });
      await db.insert(planItems).values({ planRef, taskId: created.taskId, ...itemValues, lastSeenAt: now, updatedAt: now });
      changes.push({ planRef, taskId: created.taskId, field: "added", oldValue: null, newValue: title });
      result.added++;
      if (row.pic && !picMemberId) await recordPicUnresolved(planRef, created.taskId, row.pic);
      continue;
    }

    const oldId = assigned.entry.id;
    const renumbered = oldId !== row.id;
    const reappearing = assigned.kind === "reappeared" || (item !== null && item.missingSince !== null);

    // --- What would change on the task ---------------------------------------
    const patch: Partial<typeof tasks.$inferInsert> = {};
    const changedFields: string[] = [];

    if (task.sourceReference !== sourceReference) {
      patch.sourceReference = sourceReference;
      changedFields.push(renumbered ? "renumbered" : "sourceReference");
    }
    if (task.title !== title) {
      patch.title = title;
      patch.normalizedTitle = normalizeTitle(title);
      changedFields.push("title");
    }
    if (task.adminNote !== adminNote) {
      patch.adminNote = adminNote;
      changedFields.push("adminNote");
    }
    // A date the plan leaves blank (or the parser could not read) does NOT
    // clear the task's: wiping a deadline switches its reminders off, and a
    // misread cell must not do that. The blank is still recorded as a change
    // on plan_items below, so it is not invisible.
    if (row.start !== null && task.scheduledFor !== row.start) {
      patch.scheduledFor = row.start;
      changedFields.push("scheduledFor");
    }
    if (row.deadline !== null) {
      const mustFinishBefore = mustFinishBeforeFor(row.deadline);
      if (task.deadlineLabel !== row.deadline || task.mustFinishBefore?.getTime() !== mustFinishBefore.getTime()) {
        patch.deadlineLabel = row.deadline;
        patch.mustFinishBefore = mustFinishBefore;
        changedFields.push("deadline");
      }
    }
    // Written directly rather than through tasks/service.ts transitionStatus():
    // that is the MEMBER state machine (a report may only move a task along
    // the edges it allows). The plan is authoritative and may set any status
    // from any status — e.g. Selesai back to Berjalan when the supervisor
    // reopens a step — so routing it through the table would reject exactly
    // the corrections the plan exists to make. The audit trail is kept the
    // same way: a task_events row plus the version bump below.
    //
    // A step that comes back from removal was cancelled by the sync; the plan
    // decides what it is now. If the plan's status text is one we do not
    // recognise it must still not stay cancelled.
    const effectiveStatus: TaskStatus | null = targetStatus ?? (reappearing && task.status === "cancelled" ? "active" : null);
    if (effectiveStatus !== null && task.status !== effectiveStatus) {
      patch.status = effectiveStatus;
      changedFields.push("status");
    }
    // latest_update is bot/report-owned, so the plan only writes it when the
    // plan's progress itself is news — never to "restore" it after a report
    // has replaced it, which would make the sync and the reports overwrite
    // each other every 15 minutes. For a task being adopted (no plan_items
    // row yet) it is written only over an empty value or the plan's own
    // earlier line.
    if (progressPct !== null) {
      const line = `Progress ${progressPct}% (plan, ${todayLabel})`;
      const planStyle = task.latestUpdate === null || task.latestUpdate.startsWith("Progress ");
      const write = item
        ? item.progressPct !== progressPct
        : planStyle && !(task.latestUpdate ?? "").startsWith(`Progress ${progressPct}%`);
      if (write && task.latestUpdate !== line) {
        patch.latestUpdate = line;
        changedFields.push("latestUpdate");
      }
    }

    const currentAssignees = assigneesByTask.get(task.taskId) ?? [];
    const assigneesDiffer = picMemberId !== null && !(currentAssignees.length === 1 && currentAssignees[0] === picMemberId);
    if (assigneesDiffer) changedFields.push("assignees");

    // --- What would change in the plan's own record --------------------------
    let itemChanged = false;
    if (!item) {
      result.baselined++;
    } else {
      const changed = (Object.keys(itemValues) as (keyof typeof itemValues)[]).filter((k) => item[k] !== itemValues[k]);
      // A changed plan_ref (renumbered) or a return from removal also needs the row rewritten.
      itemChanged = changed.length > 0 || item.planRef !== planRef || item.missingSince !== null;

      const record = (field: PlanChangeField, oldValue: string | null, newValue: string | null) =>
        changes.push({ planRef, taskId: task.taskId, field, oldValue, newValue });
      if (item.statusText !== row.statusText) record("status", item.statusText, row.statusText);
      if (item.progressPct !== progressPct) record("progress", pctText(item.progressPct), pctText(progressPct));
      if (item.deadlineDate !== row.deadline) record("deadline", item.deadlineDate, row.deadline);
      if (item.startDate !== row.start) record("start", item.startDate, row.start);
      if (item.picRaw !== row.pic) record("pic", item.picRaw, row.pic);
      if (item.area !== row.area || item.step !== row.step) record("title", titleFor(item.area, item.step), title);
    }
    if (reappearing) {
      changes.push({ planRef, taskId: task.taskId, field: "reappeared", oldValue: null, newValue: title });
      result.reappeared++;
    }
    if (renumbered) {
      changes.push({ planRef, taskId: task.taskId, field: "renumbered", oldValue: oldId, newValue: row.id });
      result.renumbered++;
    }
    if (row.pic && !picMemberId) await recordPicUnresolved(planRef, task.taskId, row.pic);

    // --- Write, only if something differs ------------------------------------
    if (changedFields.length > 0) {
      await db
        .update(tasks)
        .set({ ...patch, updatedAt: now, version: sql`${tasks.version} + 1` })
        .where(eq(tasks.taskId, task.taskId));
      if (assigneesDiffer && picMemberId) {
        await db.delete(taskAssignees).where(eq(taskAssignees.taskId, task.taskId));
        await db.insert(taskAssignees).values({ taskId: task.taskId, memberId: picMemberId });
      }
      await db.insert(taskEvents).values({
        taskId: task.taskId,
        eventType: "plan_sync",
        fromStatus: task.status,
        toStatus: patch.status ?? task.status,
        detail: { planRef, changedFields, ...(renumbered ? { renumberedFrom: oldId } : {}) },
      });
      result.tasksUpdated++;
    }

    if (!item) {
      await db.insert(planItems).values({ planRef, taskId: task.taskId, ...itemValues, lastSeenAt: now, updatedAt: now });
    } else if (itemChanged) {
      await db
        .update(planItems)
        .set({ ...itemValues, planRef, lastSeenAt: now, missingSince: null, updatedAt: now })
        .where(eq(planItems.taskId, task.taskId));
    } else if (now.getTime() - item.lastSeenAt.getTime() >= HEARTBEAT_MS) {
      heartbeatTaskIds.push(task.taskId);
    }

    if (changedFields.length === 0 && !itemChanged && item) result.unchanged++;
  }

  if (heartbeatTaskIds.length > 0) {
    await db.update(planItems).set({ lastSeenAt: now }).where(inArray(planItems.taskId, heartbeatTaskIds));
  }

  if (changes.length > 0) {
    await db.insert(planItemChanges).values(changes.map((c) => ({ ...c, detectedAt: now })));
  }

  return result;
}
