import { and, eq, sql } from "drizzle-orm";
import type { sheets_v4 } from "googleapis";
import type { AppDatabase } from "../db/types.ts";
import { sheetsSyncEvents, taskAssignees, taskEvents, tasks, tasksSheetSnapshot } from "../db/schema.ts";
import { TASK_STATUSES, type TaskStatus } from "../tasks/state-machine.ts";
import { normalizeTitle } from "../tasks/service.ts";
import { computeMustFinishBefore } from "../tasks/deadline.ts";
import { resolveProjectsByNameOrAlias } from "../projects/service.ts";
import { resolveMembersByNameOrAlias } from "../members/service.ts";
import { quoteA1SheetName } from "./client.ts";
import { isPlanTask } from "../plan/mapping.ts";

/**
 * MASTER_SPEC.md §18 two-way sync on TASKS. Every rule here is
 * deliberately conservative — "never guess" carries over from the same
 * convention already used for report-item task/project matching:
 *
 * - Blank task_id -> ignored, never creates a task. Import is edit-only;
 *   task creation stays the bot's job (it already handles
 *   normalizedTitle, createdByMemberId, candidate dedup — reimplementing
 *   that on the import path would be a second, divergent creation path).
 * - Unknown task_id -> rejected, logged, doesn't fail the rest of the run.
 * - A blank cell means "no change," not "clear this field" — except
 *   Catatan Admin, which is purely admin-owned (the bot never writes it),
 *   so clearing it to blank is unambiguous and safe.
 * - Status must be an exact enum value. Deadline must be strict
 *   YYYY-MM-DD (rejected, not best-effort parsed). Project/assignee names
 *   must resolve to exactly one match each — 0 or >1 rejects that field,
 *   the rest of the row still applies.
 * - A field is an EDIT only when it differs from what the export last
 *   wrote into that cell (tasks_sheet_snapshot), never merely from what
 *   the database says now. Those two tests look the same from the sheet
 *   but mean opposite things: the bot moves tasks all day (a member
 *   reporting work bumps status and version), so a row can differ from DB
 *   truth without anyone having touched it. Diffing against DB produced
 *   259 phantom conflicts and 8 WhatsApp notices accusing the division of
 *   edits nobody made (found 2026-09-01).
 * - A task with no snapshot row has never been exported since this table
 *   existed, so there is nothing to compare against; those fall back to
 *   diffing against the database, which is the pre-2026-09-01 behaviour.
 * - The optimistic lock is enforced in SQL
 *   (`WHERE task_id = $id AND version = $sheetVersion`), not a
 *   read-then-compare in JS — a JS-side check would race the live report
 *   pipeline, which writes to these same rows all day.
 */

export interface ParsedTaskRow {
  taskId: string;
  sheetVersion: number;
  title: string;
  projectText: string;
  status: string;
  deadlineText: string;
  scheduledText: string;
  assigneeNames: string[];
  adminNote: string;
}

/** Recorded as the reason on a rejected edit to a plan task. */
export const PLAN_LOCK_REASON = "task follows the plan spreadsheet — edit it there, not in the TASKS tab";

const STRICT_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Columns are located by their HEADER TEXT, never by position.
 *
 * They used to be read at fixed indices, which held only as long as the
 * layout never changed. It changed on 2026-09-08, when a "Dikerjakan"
 * column was inserted before "Penanggung Jawab" — and because the sync
 * imports before it exports, the first run after that deploy would have
 * read the OLD sheet with the NEW offsets: assignee names parsed as a
 * schedule, the admin note parsed as assignees, and the "Aktif" column
 * ("Ya") written into every task's admin note. Caught six minutes before
 * the job was due to fire, with the schedule pulled to stop it.
 *
 * Reading by name makes that class of failure impossible rather than
 * merely fixed: a column can now be added, moved, or reordered by hand in
 * the sheet and the import still finds what it is looking for. A missing
 * header for a column that must exist throws instead of silently reading
 * the wrong cells — an import that cannot locate its columns must not
 * guess.
 *
 * "Dikerjakan" is the exception, and only because it is new. The live
 * sheet does not have it until the first export after this ships, and the
 * sync imports before it exports — so requiring it would deadlock: the
 * import refuses, the export that would add the column never runs. Absent
 * is read as empty, which is safe precisely BECAUSE lookup is by name:
 * every other column is still found by its own header, whatever position
 * the missing one would have occupied.
 */
function locateColumns(header: readonly string[]): Record<keyof ParsedTaskRow, number> {
  const index = (name: string): number => {
    const at = header.findIndex((h) => (h ?? "").trim().toLowerCase() === name.toLowerCase());
    if (at < 0) throw new Error(`TASKS sheet is missing the "${name}" column — refusing to import against an unknown layout`);
    return at;
  };
  // Absent means "not written yet", not "look elsewhere" — see above.
  const optional = (name: string): number => header.findIndex((h) => (h ?? "").trim().toLowerCase() === name.toLowerCase());

  return {
    taskId: index("task_id"),
    sheetVersion: index("version"),
    title: index("Judul"),
    projectText: index("Proyek"),
    status: index("Status"),
    deadlineText: index("Deadline"),
    scheduledText: optional("Dikerjakan"),
    assigneeNames: index("Penanggung Jawab"),
    adminNote: index("Catatan Admin"),
  };
}

export async function readTasksSheet(sheets: sheets_v4.Sheets, spreadsheetId: string, tabName: string): Promise<ParsedTaskRow[]> {
  // Includes row 1 now: the header is what tells us where everything is.
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quoteA1SheetName(tabName)}!A1:Z` });
  const [header, ...rows] = data.values ?? [];
  if (!header) return [];

  const col = locateColumns(header.map((h) => String(h ?? "")));
  const cell = (row: string[], at: number): string => (at < 0 ? "" : String(row[at] ?? "").trim());

  return rows
    .filter((r) => typeof r[col.taskId] === "string" && String(r[col.taskId]).trim().length > 0)
    .map((r) => ({
      taskId: cell(r, col.taskId),
      sheetVersion: Number(cell(r, col.sheetVersion) || "0"),
      title: cell(r, col.title),
      projectText: cell(r, col.projectText),
      status: cell(r, col.status),
      deadlineText: cell(r, col.deadlineText),
      scheduledText: cell(r, col.scheduledText),
      assigneeNames: cell(r, col.assigneeNames)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
      adminNote: cell(r, col.adminNote),
    }));
}

export interface TasksImportSummary {
  applied: number;
  conflicts: number;
  rejected: number;
  unchanged: number;
  /** Rows the bot has moved on from since the last export, with no human edit on top. Normal, and silent. */
  stale: number;
  conflictedTaskTitles: string[];
}

async function resolveAssigneeMemberIds(db: AppDatabase, names: string[]): Promise<string[] | null> {
  const ids: string[] = [];
  for (const name of names) {
    const matches = await resolveMembersByNameOrAlias(db, name);
    if (matches.length !== 1) return null;
    const match = matches[0];
    if (!match) return null;
    ids.push(match.memberId);
  }
  return ids;
}

export async function diffAndApplyTasksImport(
  db: AppDatabase,
  rows: ParsedTaskRow[],
  actorMemberId: string | undefined,
  now: Date,
): Promise<TasksImportSummary> {
  const summary: TasksImportSummary = { applied: 0, conflicts: 0, rejected: 0, unchanged: 0, stale: 0, conflictedTaskTitles: [] };

  const snapshotRows = await db.select().from(tasksSheetSnapshot);
  const snapshotByTaskId = new Map(snapshotRows.map((r) => [r.taskId, r]));

  for (const row of rows) {
    const [current] = await db.select().from(tasks).where(eq(tasks.taskId, row.taskId)).limit(1);
    if (!current) {
      summary.rejected++;
      await db.insert(sheetsSyncEvents).values({ tabName: "TASKS", direction: "import", status: "rejected", detail: { taskId: row.taskId, reason: "unknown task_id" } });
      continue;
    }

    const setFields: Record<string, unknown> = {};
    const changedFieldNames: string[] = [];
    const rejectedFieldNames: string[] = [];

    // The whole point of the snapshot: a cell still holding what we last
    // wrote was not edited, however far the database has moved since. With
    // no snapshot for this task we cannot tell, so we fall back to treating
    // any difference as an edit — the pre-2026-09-01 behaviour.
    const snapshot = snapshotByTaskId.get(row.taskId);
    let touchedBySomeone = false;
    const edited = (field: "title" | "projectText" | "status" | "deadlineText" | "scheduledText" | "assigneeText" | "adminNote", sheetValue: string): boolean => {
      if (!snapshot) return true;
      if (snapshot[field] === sheetValue) return false;
      touchedBySomeone = true;
      return true;
    };

    if (row.title && edited("title", row.title) && row.title !== current.title) {
      setFields.title = row.title;
      setFields.normalizedTitle = normalizeTitle(row.title);
      changedFieldNames.push("title");
    }

    // Deliberately bypasses ../tasks/state-machine.ts's transition table —
    // an admin editing the Sheet can set status directly to any valid
    // enum value from any current status, not just the transitions a
    // chat-driven member action is allowed. Same spirit as
    // admin_cancel's `from: "any"` rule: this column is admin-only
    // (protected in Sheets, warning-only) and MASTER_SPEC.md §5.2 grants
    // admins broader override power than regular members already have.
    let newStatus: TaskStatus | undefined;
    if (row.status && edited("status", row.status) && row.status !== current.status) {
      if ((TASK_STATUSES as readonly string[]).includes(row.status)) {
        newStatus = row.status as TaskStatus;
        setFields.status = newStatus;
        changedFieldNames.push("status");
      } else {
        rejectedFieldNames.push("status");
      }
    }

    if (row.deadlineText && edited("deadlineText", row.deadlineText)) {
      const match = STRICT_ISO_DATE.exec(row.deadlineText);
      if (!match) {
        rejectedFieldNames.push("deadline");
      } else if (row.deadlineText !== (current.deadlineLabel ?? "")) {
        const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
        setFields.deadlineLabel = row.deadlineText;
        setFields.mustFinishBefore = computeMustFinishBefore(day);
        changedFieldNames.push("deadline");
      }
    }

    // The scheduled day is admin-editable like the deadline, and validated
    // the same way: strict YYYY-MM-DD, rejected rather than best-effort
    // parsed. A misread schedule sends people to the wrong place on the
    // wrong day, which is worse than an empty cell.
    if (row.scheduledText && edited("scheduledText", row.scheduledText)) {
      if (!STRICT_ISO_DATE.test(row.scheduledText)) {
        rejectedFieldNames.push("scheduled");
      } else if (row.scheduledText !== (current.scheduledFor ?? "")) {
        setFields.scheduledFor = row.scheduledText;
        changedFieldNames.push("scheduled");
      }
    }

    if (row.projectText && edited("projectText", row.projectText)) {
      const matches = await resolveProjectsByNameOrAlias(db, row.projectText);
      if (matches.length !== 1) {
        rejectedFieldNames.push("project");
      } else if (matches[0] && matches[0].projectId !== current.projectId) {
        setFields.projectId = matches[0].projectId;
        changedFieldNames.push("project");
      }
    }

    if (edited("adminNote", row.adminNote) && row.adminNote !== (current.adminNote ?? "")) {
      setFields.adminNote = row.adminNote || null;
      changedFieldNames.push("adminNote");
    }

    let targetAssigneeIds: string[] | null = null;
    if (row.assigneeNames.length > 0 && edited("assigneeText", row.assigneeNames.join(", "))) {
      const resolved = await resolveAssigneeMemberIds(db, row.assigneeNames);
      if (resolved === null) {
        rejectedFieldNames.push("assignees");
      } else {
        const currentAssignees = await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, row.taskId));
        const currentIds = new Set(currentAssignees.map((a) => a.memberId));
        const resolvedIds = new Set(resolved);
        const differs = currentIds.size !== resolvedIds.size || [...resolvedIds].some((id) => !currentIds.has(id));
        if (differs) {
          targetAssigneeIds = resolved;
          changedFieldNames.push("assignees");
        }
      }
    }

    // A task that follows an external plan (source_reference "master-plan-…",
    // see src/plan/) is owned by that plan spreadsheet: its title, project,
    // status, dates, assignee and note are rewritten from the plan on every
    // sync, so an edit made here would be silently undone within fifteen
    // minutes. Better to say so now. Every edit that would have applied is
    // turned into a rejected field instead, through the same rejectedFields
    // reporting as any other rejected edit; nothing is written to the task.
    // Fields nobody touched are not edits (same snapshot test as above), so
    // the plan sync moving a task never trips this.
    const planLocked = isPlanTask(current.sourceReference);
    let lockedEdits = 0;
    if (planLocked) {
      lockedEdits = changedFieldNames.length;
      rejectedFieldNames.push(...changedFieldNames);
      changedFieldNames.length = 0;
      for (const key of Object.keys(setFields)) delete setFields[key];
      targetAssigneeIds = null;
    }

    if (rejectedFieldNames.length > 0) {
      await db.insert(sheetsSyncEvents).values({
        tabName: "TASKS",
        direction: "import",
        status: "rejected",
        detail: {
          taskId: row.taskId,
          title: current.title,
          rejectedFields: rejectedFieldNames,
          ...(planLocked ? { reason: PLAN_LOCK_REASON } : {}),
        },
      });
    }
    if (lockedEdits > 0) {
      summary.rejected++;
      continue;
    }

    if (Object.keys(setFields).length === 0 && targetAssigneeIds === null) {
      // Nobody edited this row and it no longer matches the database: the
      // bot moved the task since the last export. Counted separately and
      // deliberately silent — this is the case that used to be announced
      // to the group as a rejected edit.
      if (snapshot && !touchedBySomeone && snapshot.version !== current.version) summary.stale++;
      else summary.unchanged++;
      continue;
    }

    const applied = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tasks)
        .set({ ...setFields, updatedAt: now, version: sql`${tasks.version} + 1` })
        .where(and(eq(tasks.taskId, row.taskId), eq(tasks.version, row.sheetVersion)))
        .returning();
      if (!updated) return false;

      if (targetAssigneeIds !== null) {
        await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, row.taskId));
        for (const memberId of targetAssigneeIds) {
          await tx.insert(taskAssignees).values({ taskId: row.taskId, memberId }).onConflictDoNothing();
        }
      }

      await tx.insert(taskEvents).values({
        taskId: row.taskId,
        eventType: "admin_sheet_edit",
        actorMemberId,
        fromStatus: current.status,
        toStatus: newStatus ?? current.status,
        detail: { changedFields: changedFieldNames },
      });

      return true;
    });

    if (!applied) {
      summary.conflicts++;
      summary.conflictedTaskTitles.push(current.title);
      await db.insert(sheetsSyncEvents).values({
        tabName: "TASKS",
        direction: "import",
        status: "conflict",
        detail: { taskId: row.taskId, title: current.title, sheetVersion: row.sheetVersion, dbVersion: current.version, attemptedFields: changedFieldNames },
      });
      continue;
    }

    summary.applied++;
    await db.insert(sheetsSyncEvents).values({
      tabName: "TASKS",
      direction: "import",
      status: "succeeded",
      detail: { taskId: row.taskId, title: current.title, changedFields: changedFieldNames },
    });
  }

  return summary;
}
