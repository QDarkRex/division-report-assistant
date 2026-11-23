import { pathToFileURL } from "node:url";
import { and, eq, notExists } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { dailyReports, members, reportItemFlags, reportRevisions } from "../db/schema.ts";
import type { AppDatabase } from "../db/types.ts";
import { addCalendarDays, calendarDayOf, formatCalendarDay, toJakartaWallClock } from "../shared/time.ts";

/**
 * One-off — NOT part of the running app. Repairs the morning overtime
 * check-ins that were filed on the wrong day.
 *
 * What happened (2026-10-03, a Saturday): five members said "absen lembur" /
 * "mengajukan lembur" between 09:17 and 09:39. reportingDayFor() puts
 * anything before 10:00 into the PREVIOUS reporting day, so each check-in
 * opened an empty overtime report on Friday 2026-10-02. (The code now dates a
 * 05:00-09:59 check-in by the calendar day; this script cleans up the rows
 * written before that fix.)
 *
 * It finds daily_reports that
 *   - are kind 'overtime',
 *   - have NO report_revisions (nothing was ever reported on them),
 *   - were created between 05:00 and 09:59 Jakarta time, and
 *   - are dated the day BEFORE their created_at calendar day,
 * and for each one:
 *   - if the member already has an overtime report on the created_at calendar
 *     day: copy overtime_start_text / overtime_end_text onto it where its own
 *     are empty, then delete the empty misplaced row;
 *   - otherwise move it (update reporting_day to the calendar day).
 *
 * Safety: every row is handled in its own transaction that first re-checks
 * that nothing references the misplaced report (no revisions, no
 * report_item_flags). If anything does, that row is left untouched and
 * reported as ABORTED. Nothing is ever deleted unless it is provably empty.
 *
 * Dry run by default (prints every action, writes nothing). Pass --apply to write.
 *
 * Usage: node dist/scripts/fix-morning-overtime-checkins-20261009.js [--apply]
 */

export type RepairAction =
  | { kind: "merge_and_delete"; reportId: string; memberName: string; fromDay: string; toDay: string; copiedStart: string | null; copiedEnd: string | null; applied: boolean }
  | { kind: "move"; reportId: string; memberName: string; fromDay: string; toDay: string; applied: boolean }
  | { kind: "aborted"; reportId: string; memberName: string; fromDay: string; toDay: string; reason: string };

export function describeRepairAction(action: RepairAction): string {
  const head = `${action.memberName}: lembur ${action.fromDay} -> ${action.toDay} (${action.reportId})`;
  switch (action.kind) {
    case "move":
      return `${action.applied ? "DIPINDAH" : "AKAN DIPINDAH"}  ${head}`;
    case "merge_and_delete": {
      const copied = [action.copiedStart ? `start="${action.copiedStart}"` : null, action.copiedEnd ? `end="${action.copiedEnd}"` : null].filter(Boolean);
      return `${action.applied ? "DIGABUNG+DIHAPUS" : "AKAN DIGABUNG+DIHAPUS"}  ${head}  salin: ${copied.length ? copied.join(", ") : "(tidak ada)"}`;
    }
    case "aborted":
      return `DIBATALKAN  ${head}  alasan: ${action.reason}`;
  }
}

const isEmpty = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === "";

export async function repairMorningOvertimeCheckins(db: AppDatabase, apply: boolean): Promise<RepairAction[]> {
  // Date math is done here with the project's own Jakarta helpers rather than
  // in SQL, so the same rule the code uses decides which rows qualify.
  const overtime = await db
    .select({
      reportId: dailyReports.reportId,
      memberId: dailyReports.memberId,
      memberName: members.preferredName,
      reportingDay: dailyReports.reportingDay,
      startText: dailyReports.overtimeStartText,
      endText: dailyReports.overtimeEndText,
      createdAt: dailyReports.createdAt,
    })
    .from(dailyReports)
    .innerJoin(members, eq(dailyReports.memberId, members.memberId))
    .where(
      and(
        eq(dailyReports.kind, "overtime"),
        // Zero revisions: nothing was ever reported on the row.
        notExists(db.select({ one: reportRevisions.revisionId }).from(reportRevisions).where(eq(reportRevisions.reportId, dailyReports.reportId))),
      ),
    )
    .orderBy(dailyReports.createdAt);

  const actions: RepairAction[] = [];
  for (const row of overtime) {
    const wall = toJakartaWallClock(row.createdAt);
    if (wall.hour < 5 || wall.hour > 9) continue;
    const createdDay = calendarDayOf(row.createdAt);
    const toDay = formatCalendarDay(createdDay);
    const fromDay = formatCalendarDay(addCalendarDays(createdDay, -1));
    if (row.reportingDay !== fromDay) continue;

    const base = { reportId: row.reportId, memberName: row.memberName, fromDay, toDay };
    const action = await db.transaction(async (tx): Promise<RepairAction> => {
      // Re-verified inside the transaction: it must be provably empty.
      const revisions = await tx.select({ id: reportRevisions.revisionId }).from(reportRevisions).where(eq(reportRevisions.reportId, row.reportId)).limit(1);
      if (revisions.length > 0) return { kind: "aborted", ...base, reason: "punya revisi laporan" };
      const flags = await tx.select({ id: reportItemFlags.flagId }).from(reportItemFlags).where(eq(reportItemFlags.reportId, row.reportId)).limit(1);
      if (flags.length > 0) return { kind: "aborted", ...base, reason: "dirujuk report_item_flags" };

      const [target] = await tx
        .select()
        .from(dailyReports)
        .where(and(eq(dailyReports.memberId, row.memberId), eq(dailyReports.reportingDay, toDay), eq(dailyReports.kind, "overtime")))
        .limit(1);

      if (target) {
        const copiedStart = isEmpty(target.overtimeStartText) && !isEmpty(row.startText) ? row.startText : null;
        const copiedEnd = isEmpty(target.overtimeEndText) && !isEmpty(row.endText) ? row.endText : null;
        if (apply) {
          if (copiedStart || copiedEnd) {
            await tx
              .update(dailyReports)
              .set({ ...(copiedStart ? { overtimeStartText: copiedStart } : {}), ...(copiedEnd ? { overtimeEndText: copiedEnd } : {}) })
              .where(eq(dailyReports.reportId, target.reportId));
          }
          await tx.delete(dailyReports).where(eq(dailyReports.reportId, row.reportId));
        }
        return { kind: "merge_and_delete", ...base, copiedStart, copiedEnd, applied: apply };
      }

      if (apply) await tx.update(dailyReports).set({ reportingDay: toDay }).where(eq(dailyReports.reportId, row.reportId));
      return { kind: "move", ...base, applied: apply };
    });
    actions.push(action);
  }
  return actions;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  try {
    console.log(`${apply ? "APPLY" : "DRY RUN"} — perbaiki absen lembur pagi yang salah hari`);
    const actions = await repairMorningOvertimeCheckins(db, apply);
    for (const action of actions) console.log(`  ${describeRepairAction(action)}`);
    const aborted = actions.filter((a) => a.kind === "aborted").length;
    console.log(`Selesai: ${actions.length} baris, ${aborted} dibatalkan.${apply ? "" : " (dry run — tidak ada yang ditulis; jalankan dengan --apply)"}`);
  } finally {
    await pool.end();
  }
}

// Only when run directly, so the repair function can be imported by its test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("FIX_MORNING_OVERTIME_ERROR:", error);
    process.exit(1);
  });
}

