import type { AppDatabase } from "../db/types.ts";
import { parsePlanGrid, type PlanParseResult } from "./parse.ts";
import { fetchPlanGrid, type ReadOnlySheets } from "./sheet-source.ts";
import { syncPlan, type SyncPlanResult } from "./sync.ts";

export interface PlanSyncConfig {
  /** Read-only by construction — see sheet-source.ts. */
  sheets: ReadOnlySheets;
  spreadsheetId: string;
  sheetName: string;
  sourceKey: string;
  projectName: string;
}

export interface RunPlanSyncResult {
  parsed: PlanParseResult;
  sync: SyncPlanResult;
  /** True when another run was already in progress in this process and this call did nothing. */
  skipped?: boolean;
}

/**
 * Only one plan sync at a time per process (the DB-level advisory lock in
 * sync.ts covers the cron job racing a manual script in another process).
 * Same guard, same reason, as runTasksSync.
 */
let inFlight = false;

/** Fetch -> parse -> sync. The whole pipeline, shared by the scheduled job and the manual script. */
export async function runPlanSync(
  db: AppDatabase,
  config: PlanSyncConfig,
  now: Date,
  options: { dryRun: boolean; allowMassRemoval?: boolean },
): Promise<RunPlanSyncResult | null> {
  if (inFlight) return null;
  inFlight = true;
  try {
    const grid = await fetchPlanGrid(config.sheets, config.spreadsheetId, config.sheetName);
    const parsed = parsePlanGrid(grid);
    const sync = await syncPlan(db, parsed.rows, {
      sourceKey: config.sourceKey,
      projectName: config.projectName,
      now,
      dryRun: options.dryRun,
      ...(options.allowMassRemoval ? { allowMassRemoval: true } : {}),
    });
    return { parsed, sync };
  } finally {
    inFlight = false;
  }
}

/** The one line the job logs per run. */
export function formatPlanSyncSummary(result: RunPlanSyncResult): string {
  const s = result.sync;
  const parts = [
    `rows=${s.rowsParsed}`,
    `unchanged=${s.unchanged}`,
    `updated=${s.tasksUpdated}`,
    `added=${s.added}`,
    `baselined=${s.baselined}`,
    `removed=${s.removed}`,
    `reappeared=${s.reappeared}`,
    `renumbered=${s.renumbered}`,
    `pic_unresolved=${s.picUnresolved}`,
    `changes=${s.changes.length}`,
    `warnings=${result.parsed.warnings.length}`,
  ];
  return `plan-sync ${s.dryRun ? "(dry run) " : ""}${parts.join(" ")}`;
}

/** One line per identity decision worth a log entry: steps that moved ID, came back, or were too ambiguous to guess. */
export function formatPlanIdentityLog(result: RunPlanSyncResult): string[] {
  const id = result.sync.identity;
  return [
    ...id.moved.map((m) => `plan-sync renumbered ${m.from} -> ${m.to} (similarity ${m.score.toFixed(2)})`),
    ...id.reappeared.map((m) => `plan-sync reappeared ${m.from} -> ${m.to} (similarity ${m.score.toFixed(2)})`),
    ...id.ambiguous.map((a) => `plan-sync ambiguous (${a.pass}): rows ${a.rowIds.join(",")} vs known ${a.entryIds.join(",")} — not matched`),
  ];
}
