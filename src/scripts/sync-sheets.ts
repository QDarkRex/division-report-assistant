import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { createSheetsClient } from "../sheets/client.ts";
import { runReportsSync } from "../jobs/reports-sync.ts";
import type { CalendarDay } from "../shared/time.ts";

/**
 * Manual CLI wrapper around jobs/reports-sync.ts's runReportsSync() — the
 * same function the hourly wdh.reports-sync scheduled job calls. Kept for
 * ad-hoc backfills that the scheduled job's bounded 7-day window doesn't
 * cover — a format change, or (2026-08-14) pre-creating the rest of the
 * year's date tabs on request: --backfill-from=2026-08-14 --until=2026-12-31.
 *
 * Usage: node dist/scripts/sync-sheets.js <credentialsPath> <spreadsheetId> [--backfill-from=YYYY-MM-DD] [--until=YYYY-MM-DD]
 */
function parseDayFlag(argv: string[], flagName: string): CalendarDay | null {
  const flag = argv.find((a) => a.startsWith(`--${flagName}=`));
  if (!flag) return null;
  const value = flag.split("=")[1] ?? "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`--${flagName} must be YYYY-MM-DD, got "${value}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

async function main() {
  const credentialsPath = process.argv[2];
  const spreadsheetId = process.argv[3];
  const databaseUrl = process.env.DATABASE_URL;
  const rest = process.argv.slice(4);
  const backfillFrom = parseDayFlag(rest, "backfill-from");
  const backfillUntil = parseDayFlag(rest, "until");

  if (!credentialsPath || !spreadsheetId) {
    console.error("Usage: node sync-sheets.js <credentialsPath> <spreadsheetId> [--backfill-from=YYYY-MM-DD] [--until=YYYY-MM-DD]");
    process.exit(1);
  }
  if (backfillUntil && !backfillFrom) {
    console.error("--until requires --backfill-from");
    process.exit(1);
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const serviceAccountKeyJson = readFileSync(credentialsPath, "utf-8");
  const sheets = createSheetsClient({ serviceAccountKeyJson, spreadsheetId });

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const result = await runReportsSync(sheets, spreadsheetId, db, new Date(), backfillFrom, backfillUntil);
  for (const tabName of result.syncedTabs) console.log(`SYNCED: ${tabName}`);
  for (const failure of result.failedTabs) console.error(`SYNC_FAILED: ${failure.tabName}:`, failure.message);

  await pool.end();
  if (result.failedTabs.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error("SYNC_SHEETS_ERROR:", error);
  process.exit(1);
});
