import { eq, inArray } from "drizzle-orm";
import type { sheets_v4 } from "googleapis";
import type { AppDatabase } from "../db/types.ts";
import { members, projects, taskAssignees, tasks, tasksSheetSnapshot } from "../db/schema.ts";
import { toJakartaWallClock } from "../shared/time.ts";
import { TASK_STATUSES } from "../tasks/state-machine.ts";
import { columnIndex, getSheetId } from "./formatting.ts";

/**
 * MASTER_SPEC.md §18: TASKS is the one Sheets tab with two-way sync.
 * Editable columns: title, project, status, deadline, current assignees,
 * admin notes, active/inactive (owner decision 2026-08-06, addendum —
 * chief review suggested export-only, owner chose to keep two-way).
 *
 * task_id and version are exported but read-only from the sync's point
 * of view (protected in formatting via addProtectedRange, warning-only)
 * — task_id is how tasks-import.ts finds the row to update, version is
 * the optimistic-lock value it must round-trip back unchanged for an
 * edit to apply cleanly.
 */
export const TASKS_HEADER = [
  "task_id",
  "version",
  "Judul",
  "Proyek",
  "Status",
  "Deadline",
  "Dikerjakan",
  "Penanggung Jawab",
  "Catatan Admin",
  "Aktif",
  "Update Terakhir",
  "Diperbarui",
];

function formatJakartaDateTime(instant: Date | null): string {
  if (!instant) return "";
  const w = toJakartaWallClock(instant);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

export async function buildTasksRows(db: AppDatabase): Promise<string[][]> {
  const taskRows = await db.select().from(tasks);

  const projectIds = [...new Set(taskRows.map((t) => t.projectId).filter((id): id is string => id !== null))];
  const projectRows = projectIds.length > 0 ? await db.select().from(projects).where(inArray(projects.projectId, projectIds)) : [];
  const projectNameById = new Map(projectRows.map((p) => [p.projectId, p.name]));

  const taskIds = taskRows.map((t) => t.taskId);
  const assigneeRows =
    taskIds.length > 0
      ? await db
          .select({ taskId: taskAssignees.taskId, name: members.preferredName })
          .from(taskAssignees)
          .innerJoin(members, eq(taskAssignees.memberId, members.memberId))
          .where(inArray(taskAssignees.taskId, taskIds))
      : [];
  const assigneeNamesByTaskId = new Map<string, string[]>();
  for (const row of assigneeRows) {
    const list = assigneeNamesByTaskId.get(row.taskId) ?? [];
    list.push(row.name);
    assigneeNamesByTaskId.set(row.taskId, list);
  }

  const sorted = [...taskRows].sort((a, b) => a.title.localeCompare(b.title));

  return [
    TASKS_HEADER,
    ...sorted.map((t) => [
      t.taskId,
      String(t.version),
      t.title,
      t.projectId ? (projectNameById.get(t.projectId) ?? "") : "",
      t.status,
      t.deadlineLabel ?? "",
      t.scheduledFor ?? "",
      (assigneeNamesByTaskId.get(t.taskId) ?? []).join(", "),
      t.adminNote ?? "",
      t.status === "done" || t.status === "cancelled" ? "Tidak" : "Ya",
      t.latestUpdate ?? "",
      formatJakartaDateTime(t.updatedAt),
    ]),
  ];
}

/**
 * Records what we just wrote into TASKS, so the next import can tell a
 * human edit from a row that is merely out of date. Derived from the
 * exported cell values rather than re-read from the database: the point is
 * to capture what is literally in the sheet, and a second query could
 * disagree with the array we just sent.
 *
 * Called only after replaceTabContent() succeeds — a snapshot claiming
 * cells that were never written would make the next import treat real
 * sheet content as an edit, or worse, ignore a real one.
 */
export async function saveTasksSnapshot(db: AppDatabase, exportRows: string[][]): Promise<void> {
  const [header, ...body] = exportRows;
  if (!header || body.length === 0) return;

  const col = {
    taskId: columnIndex(header, "task_id"),
    version: columnIndex(header, "version"),
    title: columnIndex(header, "Judul"),
    project: columnIndex(header, "Proyek"),
    status: columnIndex(header, "Status"),
    deadline: columnIndex(header, "Deadline"),
    scheduled: columnIndex(header, "Dikerjakan"),
    assignees: columnIndex(header, "Penanggung Jawab"),
    adminNote: columnIndex(header, "Catatan Admin"),
  };

  const values = body.map((r) => ({
    taskId: r[col.taskId] ?? "",
    version: Number(r[col.version] ?? "0"),
    title: r[col.title] ?? "",
    projectText: r[col.project] ?? "",
    status: r[col.status] ?? "",
    deadlineText: r[col.deadline] ?? "",
    scheduledText: r[col.scheduled] ?? "",
    assigneeText: r[col.assignees] ?? "",
    adminNote: r[col.adminNote] ?? "",
    exportedAt: new Date(),
  }));

  // Upsert rather than delete-then-insert: the import runs against this
  // table every hour, and a window where it is empty would look exactly
  // like "no task has ever been exported".
  for (const value of values) {
    await db
      .insert(tasksSheetSnapshot)
      .values(value)
      .onConflictDoUpdate({ target: tasksSheetSnapshot.taskId, set: value });
  }
}

const READ_ONLY_HEADERS = ["task_id", "version", "Aktif", "Update Terakhir", "Diperbarui"];

/**
 * Warning-only protection on the read-only columns (task_id/version/
 * derived/bot-owned fields), plus a strict dropdown on Status so a typo'd
 * status value is caught at entry instead of surfacing as an import
 * rejection later.
 *
 * setDataValidation truly overwrites (safe to call every sync), but
 * addProtectedRange does NOT dedupe — like conditional-format rules and
 * bandings elsewhere in this codebase, repeat calls accumulate duplicate
 * protected ranges over the same cells. Existing protected ranges for
 * this sheet are deleted first, every sync, before re-adding.
 */
export async function applyTasksProtectionAndValidation(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabName: string,
  headerRow: string[],
): Promise<void> {
  const sheetId = await getSheetId(sheets, spreadsheetId, tabName);
  const statusColIndex = columnIndex(headerRow, "Status");

  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId),protectedRanges(protectedRangeId))" });
  const existingSheet = (data.sheets ?? []).find((s) => s.properties?.sheetId === sheetId);
  const existingProtectedRangeIds = (existingSheet?.protectedRanges ?? [])
    .map((p) => p.protectedRangeId)
    .filter((id): id is number => id !== undefined && id !== null);
  if (existingProtectedRangeIds.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: existingProtectedRangeIds.map((protectedRangeId) => ({ deleteProtectedRange: { protectedRangeId } })) },
    });
  }

  const requests: sheets_v4.Schema$Request[] = [
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: statusColIndex, endColumnIndex: statusColIndex + 1 },
        rule: {
          condition: { type: "ONE_OF_LIST", values: TASK_STATUSES.map((s) => ({ userEnteredValue: s })) },
          strict: true,
          showCustomUi: true,
        },
      },
    },
    ...READ_ONLY_HEADERS.map((header) => {
      const colIndex = columnIndex(headerRow, header);
      return {
        addProtectedRange: {
          protectedRange: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
            warningOnly: true,
            description: `${header} dikelola bot, jangan diedit manual`,
          },
        },
      };
    }),
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}
