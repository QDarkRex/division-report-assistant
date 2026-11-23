import type { sheets_v4 } from "googleapis";
import type { AppDatabase } from "../db/types.ts";
import { readTasksSheet, diffAndApplyTasksImport, type TasksImportSummary } from "../sheets/tasks-import.ts";
import { applyTasksProtectionAndValidation, buildTasksRows, saveTasksSnapshot, TASKS_HEADER } from "../sheets/tasks-export.ts";
import { ensureTabsExist, replaceTabContent } from "../sheets/client.ts";
import { ensureTabFormatting, TASKS_FORMAT } from "../sheets/formatting.ts";

/**
 * Import FIRST, then export — the cycle ends showing DB truth including
 * any edit just applied. Export-then-import would show the admin stale
 * data and apply their edit invisibly (Opus design review, 2026-08-08).
 */
export interface RunTasksSyncResult {
  importSummary: TasksImportSummary;
  exportRowCount: number;
  /** True when another sync was already running and this call did nothing. Not a failure. */
  skipped?: boolean;
}

/**
 * Only one TASKS sync at a time, per process — the same guard
 * runReportsSync got on 2026-09-05, for the same reason.
 *
 * This one reads the sheet, applies edits, then overwrites the sheet from
 * the database. Two of those interleaving can drop an admin's edit
 * entirely: the second run reads the sheet after the first has already
 * rewritten it from DB truth, so the edit is simply not there any more.
 */
let syncInFlight = false;

export async function runTasksSync(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  db: AppDatabase,
  actorMemberId: string | undefined,
  now: Date,
): Promise<RunTasksSyncResult> {
  if (syncInFlight) return { importSummary: emptyImportSummary(), exportRowCount: 0, skipped: true };
  syncInFlight = true;
  try {
    return await runTasksSyncUnguarded(sheets, spreadsheetId, db, actorMemberId, now);
  } finally {
    syncInFlight = false;
  }
}

function emptyImportSummary(): TasksImportSummary {
  return { applied: 0, conflicts: 0, rejected: 0, unchanged: 0, stale: 0, conflictedTaskTitles: [] };
}

async function runTasksSyncUnguarded(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  db: AppDatabase,
  actorMemberId: string | undefined,
  now: Date,
): Promise<RunTasksSyncResult> {
  await ensureTabsExist(sheets, spreadsheetId, ["TASKS"]);

  const importedRows = await readTasksSheet(sheets, spreadsheetId, "TASKS");
  const importSummary = await diffAndApplyTasksImport(db, importedRows, actorMemberId, now);

  const exportRows = await buildTasksRows(db);
  await replaceTabContent(sheets, spreadsheetId, "TASKS", exportRows);
  // Only after the write lands: the snapshot is a claim about what is in
  // the sheet, and recording cells we failed to write would make the next
  // import misread real content as an edit.
  await saveTasksSnapshot(db, exportRows);
  await ensureTabFormatting(sheets, spreadsheetId, TASKS_FORMAT, exportRows[0] ?? TASKS_HEADER);
  await applyTasksProtectionAndValidation(sheets, spreadsheetId, "TASKS", exportRows[0] ?? TASKS_HEADER);

  return { importSummary, exportRowCount: exportRows.length - 1 };
}

/**
 * A rejected sheet edit is overwritten by the export step's DB-truth
 * rewrite with no visible trace unless something says so — this is that
 * something. Called by the scheduler job alongside runTasksSync() so a
 * conflict actually reaches the group instead of silently vanishing.
 *
 * Since 2026-09-01 a conflict means what it says: somebody edited a cell
 * AND the task changed underneath them. Rows that merely lag the database
 * are counted as `stale` and say nothing — they were the source of all 8
 * notices this had sent, every one of them about an edit nobody made.
 */
export function formatConflictNotice(summary: TasksImportSummary): string | null {
  if (summary.conflicts === 0) return null;
  return `${summary.conflicts} edit di Sheet TASKS ditolak karena data sudah berubah duluan — silakan cek ulang: ${summary.conflictedTaskTitles.join(", ")}`;
}
