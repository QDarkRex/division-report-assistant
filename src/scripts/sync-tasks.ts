import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { createSheetsClient } from "../sheets/client.ts";
import { runTasksSync, formatConflictNotice } from "../jobs/sheets-sync.ts";

/**
 * Manual one-off run of the two-way TASKS sync, separate from
 * scheduler.ts's hourly job — run this by hand first to verify against
 * the real spreadsheet before setting SHEETS_CREDENTIALS_PATH/
 * SHEETS_SPREADSHEET_ID in the live deploy (which turns on the scheduled
 * job automatically, see server.ts). Same verify-before-schedule pattern
 * already used for the report Sheets sync.
 *
 * Usage: node dist/scripts/sync-tasks.js <credentialsPath> <spreadsheetId> [adminActorMemberId]
 */
async function main() {
  const credentialsPath = process.argv[2];
  const spreadsheetId = process.argv[3];
  const adminActorMemberId = process.argv[4];
  const databaseUrl = process.env.DATABASE_URL;

  if (!credentialsPath || !spreadsheetId) {
    console.error("Usage: node sync-tasks.js <credentialsPath> <spreadsheetId> [adminActorMemberId]");
    process.exit(1);
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const serviceAccountKeyJson = readFileSync(credentialsPath, "utf-8");
  const sheets = createSheetsClient({ serviceAccountKeyJson, spreadsheetId });

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const result = await runTasksSync(sheets, spreadsheetId, db, adminActorMemberId, new Date());

  console.log(`IMPORT: applied=${result.importSummary.applied} conflicts=${result.importSummary.conflicts} rejected=${result.importSummary.rejected} stale=${result.importSummary.stale} unchanged=${result.importSummary.unchanged}`);
  const notice = formatConflictNotice(result.importSummary);
  if (notice) console.log(`CONFLICT_NOTICE (would be sent to group): ${notice}`);
  console.log(`EXPORT: ${result.exportRowCount} tasks`);

  await pool.end();
}

main().catch((error) => {
  console.error("SYNC_TASKS_ERROR:", error);
  process.exit(1);
});
