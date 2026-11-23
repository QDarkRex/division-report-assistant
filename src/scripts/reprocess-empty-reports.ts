import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { dailyReports, members, reportItems, reportRevisions } from "../db/schema.ts";
import { processReportContent } from "../messages/pipeline.ts";
import { fromJakartaWallClock } from "../shared/time.ts";

/**
 * Admin recovery — NOT part of the running app. Re-extracts the reports
 * emptied by the 2026-08-12 defaults regression (see llm/schemas.ts's
 * refine): stored with real raw text, zero report_items, and noActivity
 * false, which the Sheets date tab then rendered as "tidak ada aktivitas".
 *
 * Reads the raw text straight from report_revisions rather than
 * incoming_messages — the text is already there, and the 30-day raw-text
 * redaction job may have cleared the incoming_messages copy for the older
 * ones.
 *
 * `now` is pinned to NOON of the report's own reporting day, never the
 * real clock: processReportContent derives the reporting day from it, and
 * passing the current time is exactly the bug that corrupted a report on
 * 2026-08-08 (reprocess-message.ts's fix). Noon is safely inside the
 * 10:00-onward window for that day.
 *
 * Dry run by default. Pass --apply to actually write.
 *
 * Usage: node dist/scripts/reprocess-empty-reports.js [--apply]
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const litellmApiKey = process.env.LITELLM_API_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!litellmBaseUrl) throw new Error("LITELLM_BASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  // Reports whose every revision produced no items at all. The length
  // guard skips genuinely near-empty texts, which are a different case
  // from "the model returned nothing for real content".
  //
  // Exactly ONE row per report — the LATEST revision. Joining revisions
  // directly returns one row per revision, and re-extracting each would
  // multiply the member's work: Yudha's 2026-08-28 report has four
  // revisions that are successive rewrites of the same activities, so
  // reprocessing all four would record that day's work four times. The
  // last revision is the member's final version of the day; the earlier
  // raw texts stay in the table untouched either way.
  const affected = await db
    .select({
      reportId: dailyReports.reportId,
      memberId: dailyReports.memberId,
      reportingDay: dailyReports.reportingDay,
      memberName: members.preferredName,
      rawText: reportRevisions.rawText,
      revisionNumber: reportRevisions.revisionNumber,
    })
    .from(dailyReports)
    .innerJoin(members, eq(members.memberId, dailyReports.memberId))
    .innerJoin(reportRevisions, eq(reportRevisions.reportId, dailyReports.reportId))
    .where(
      and(
        eq(dailyReports.noActivity, false),
        sql`length(${reportRevisions.rawText}) > 40`,
        sql`${reportRevisions.revisionNumber} = (
              select max(rr_max.revision_number) from ${reportRevisions} rr_max
              where rr_max.report_id = ${dailyReports.reportId})`,
        sql`not exists (select 1 from ${reportItems} ri
                        join ${reportRevisions} rr2 on rr2.revision_id = ri.revision_id
                        where rr2.report_id = ${dailyReports.reportId})`,
      ),
    )
    .orderBy(dailyReports.reportingDay);

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${affected.length} report(s) with content but zero items\n`);

  let recovered = 0;
  let stillEmpty = 0;
  let failed = 0;

  for (const row of affected) {
    const [year, month, day] = row.reportingDay.split("-").map(Number);
    if (!year || !month || !day) {
      console.error(`SKIP ${row.memberName} ${row.reportingDay}: unparseable reporting day`);
      continue;
    }
    const label = `${row.reportingDay} ${row.memberName}`;

    if (!apply) {
      console.log(`WOULD REPROCESS: ${label} (rev ${row.revisionNumber}, ${row.rawText.length} chars)`);
      continue;
    }

    const [member] = await db.select().from(members).where(eq(members.memberId, row.memberId)).limit(1);
    if (!member) {
      console.error(`SKIP ${label}: member row vanished`);
      continue;
    }

    try {
      const outcome = await processReportContent(
        db,
        { baseUrl: litellmBaseUrl, ...(litellmApiKey ? { apiKey: litellmApiKey } : {}) },
        member,
        row.rawText,
        `reprocess-empty:${row.reportId}`,
        fromJakartaWallClock(year, month, day, 12, 0, 0, 0),
      );

      if (outcome.status === "report_processed") {
        recovered++;
        console.log(`RECOVERED: ${label} -> ${outcome.summary.activityCount} aktivitas`);
      } else {
        stillEmpty++;
        console.log(`STILL EMPTY: ${label} -> ${outcome.status}`);
      }
    } catch (error) {
      failed++;
      console.error(`FAILED: ${label}:`, error instanceof Error ? error.message : String(error));
    }
  }

  if (apply) {
    console.log(`\nrecovered=${recovered} stillEmpty=${stillEmpty} failed=${failed}`);
  }

  await pool.end();
}

main().catch((error) => {
  console.error("REPROCESS_ERROR:", error);
  process.exit(1);
});
