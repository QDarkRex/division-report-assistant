import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { createReadOnlySheetsClient } from "../plan/sheet-source.ts";
import { formatPlanSyncSummary, runPlanSync } from "../plan/run.ts";

/**
 * Manual run of the plan sync (src/plan/), separate from the scheduled job —
 * use it to see what the next scheduled run would change before turning
 * PLAN_SPREADSHEET_ID on in the deploy. The plan spreadsheet is only ever
 * read (readonly scope).
 *
 * DRY RUN BY DEFAULT: computes and prints the change list, persists nothing.
 * Pass --apply to write.
 *
 * Env: DATABASE_URL (required); PLAN_SPREADSHEET_ID, PLAN_SHEET_NAME,
 * PLAN_SOURCE_KEY, PLAN_PROJECT_NAME as in the app (the id is required here).
 *
 * --allow-mass-removal lifts the guard that refuses a run which would remove
 * more than 30% of the known steps (use it once, when the supervisor really did
 * delete that much).
 *
 * Usage: node dist/scripts/sync-plan.js <credentialsPath> [--apply] [--allow-mass-removal]
 */
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowMassRemoval = args.includes("--allow-mass-removal");
  const credentialsPath = args.find((a) => !a.startsWith("--"));
  const databaseUrl = process.env.DATABASE_URL;
  const spreadsheetId = process.env.PLAN_SPREADSHEET_ID;

  if (!credentialsPath) {
    console.error("Usage: node sync-plan.js <credentialsPath> [--apply]");
    process.exit(1);
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!spreadsheetId) throw new Error("PLAN_SPREADSHEET_ID is required");

  const sheets = createReadOnlySheetsClient(readFileSync(credentialsPath, "utf-8"));
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    const result = await runPlanSync(
      db,
      {
        sheets,
        spreadsheetId,
        sheetName: process.env.PLAN_SHEET_NAME ?? "Master Plan",
        sourceKey: process.env.PLAN_SOURCE_KEY ?? "aerolift",
        projectName: process.env.PLAN_PROJECT_NAME ?? "Aerolift Drone Mobil",
      },
      new Date(),
      { dryRun: !apply, allowMassRemoval },
    );
    if (!result) throw new Error("another plan sync is already running");

    console.log(`${apply ? "APPLY" : "DRY RUN"} — header at sheet row ${result.parsed.headerRow}`);
    for (const warning of result.parsed.warnings) console.log(`  PERINGATAN ${warning}`);
    if (result.sync.changes.length === 0) console.log("  (tidak ada perubahan rencana)");
    for (const c of result.sync.changes) {
      console.log(`  ${c.planRef.padEnd(16)} ${c.field.padEnd(14)} ${c.oldValue ?? "-"} -> ${c.newValue ?? "-"}`);
    }
    for (const m of result.sync.identity.moved) console.log(`  PINDAH ID ${m.from} -> ${m.to} (kemiripan ${m.score.toFixed(2)})`);
    for (const m of result.sync.identity.reappeared) console.log(`  MUNCUL LAGI ${m.from} -> ${m.to} (kemiripan ${m.score.toFixed(2)})`);
    for (const a of result.sync.identity.ambiguous) console.log(`  AMBIGU (tidak ditebak) baris ${a.rowIds.join(",")} vs langkah lama ${a.entryIds.join(",")}`);
    console.log(formatPlanSyncSummary(result));
    if (!apply) console.log("Dry run — nothing was written. Re-run with --apply to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("SYNC_PLAN_ERROR:", error);
  process.exit(1);
});
