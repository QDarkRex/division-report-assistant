import type { sheets_v4 } from "googleapis";
import type { AppDatabase } from "../db/types.ts";
import { sheetsSyncEvents } from "../db/schema.ts";
import { deleteTabIfExists, ensureSizedTabExists, ensureTabsExist, replaceTabContent } from "../sheets/client.ts";
import { buildDailyReportsRows, buildMembersRows, buildWeeklyRecapRows, buildWeeklySummariesRows, buildWorkStreamsRows } from "../sheets/export.ts";
import { DAILY_REPORTS_FORMAT, ensureTabFormatting, getSheetId, MEMBERS_FORMAT, WEEKLY_RECAP_FORMAT, WEEKLY_SUMMARIES_FORMAT, WORK_STREAMS_FORMAT } from "../sheets/formatting.ts";
import { applyDateTabFormatting, assertNotReservedTabName, buildDateTabRows, dateTabName, DATE_TAB_HEADER, resetDateTabLayout } from "../sheets/date-tabs.ts";
import { addCalendarDays, calendarDayDiff, calendarDayOf, type CalendarDay } from "../shared/time.ts";

const SYNC_WINDOW_DAYS = 7;

/**
 * Google Sheets' per-minute read/write quota (60/min/user by default) is
 * shared across EVERY API call this sync makes, not just per date tab.
 * Found live 2026-08-28 syncing a large owner-requested backfill (~126
 * date tabs in one run, no pacing at all): 44 of them failed with "Quota
 * exceeded ... Read/Write requests per minute per user" because each tab
 * costs several calls (ensureSizedTabExists, getSheetId,
 * resetDateTabLayout, replaceTabContent, applyDateTabFormatting) and
 * nothing paced or retried them. The normal hourly job's 8-day window
 * stayed under quota by luck of being small, not by design — the same
 * failure was always reachable, just not yet triggered.
 */
const INTER_TAB_DELAY_MS = 400;
const MAX_QUOTA_RETRIES = 4;
const QUOTA_RETRY_BASE_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exported so the classification itself (not the sleep/retry timing) is unit-testable without mocking a Sheets client. */
export function isQuotaExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /quota exceeded/i.test(message);
}

/** Same backstop as tasks-import's row cap — a mistyped --until= (e.g. a wrong year) must fail loud, not silently enumerate years of tabs. */
const MAX_BACKFILL_DAYS = 400;

/**
 * Pure so the boundary logic (inclusive end, backfillUntil defaulting to
 * today, the >400-day guard) can be tested without a Sheets client or a
 * database. Two distinct callers, two distinct defaults:
 *  - the hourly scheduled job passes neither bound -> the existing rolling
 *    7-day-back window (SYNC_WINDOW_DAYS), unchanged from before this was
 *    extracted.
 *  - an explicit backfillFrom (CLI --backfill-from=) walks forward to
 *    backfillUntil if given, otherwise stops at today (the original
 *    "catch this range up to now" behavior) — never past today unless the
 *    caller explicitly asked for a future end date, which is exactly what
 *    the owner's "buatkan tab sampai akhir tahun" request needs
 *    (--backfill-from=today --until=2026-12-31).
 */
export function computeSyncDays(today: CalendarDay, backfillFrom: CalendarDay | null, backfillUntil: CalendarDay | null): CalendarDay[] {
  if (!backfillFrom) {
    const days: CalendarDay[] = [];
    for (let i = SYNC_WINDOW_DAYS; i >= 0; i--) days.push(addCalendarDays(today, -i));
    return days;
  }

  const rangeEnd = backfillUntil ?? today;
  if (calendarDayDiff(rangeEnd, backfillFrom) < 0) {
    throw new Error(`backfillUntil (${JSON.stringify(rangeEnd)}) is before backfillFrom (${JSON.stringify(backfillFrom)})`);
  }

  const days: CalendarDay[] = [];
  let cursor = backfillFrom;
  while (calendarDayDiff(rangeEnd, cursor) >= 0) {
    if (days.length >= MAX_BACKFILL_DAYS) {
      throw new Error(`backfill range exceeds ${MAX_BACKFILL_DAYS} days — check --backfill-from/--until`);
    }
    days.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  return days;
}

export interface ReportsSyncResult {
  syncedTabs: string[];
  failedTabs: Array<{ tabName: string; message: string }>;
  /** True when another sync was already running and this call did nothing. Not a failure. */
  skipped?: boolean;
}

/**
 * Only one sync at a time, per process.
 *
 * ensureTabFormatting() reads how many conditional-format rules and banded
 * ranges a tab has, then deletes exactly that many before adding its own.
 * Two syncs interleaving turns that into a race: both read 1 rule, the
 * first deletes it, the second gets "No conditional format on sheet: X at
 * index: 0", or both add a banding and the second gets "cannot add
 * alternating background colors to a range that already has" them.
 *
 * Found live 2026-09-05. Zero sync failures Aug 29 - Sep 3; 17 across
 * Sep 4-5, every single one at :30 past the hour — the exact minute where
 * the hourly job at minute 30 and the every-five-minutes evening job
 * introduced on Sep 4 (which also lands on 30) fire together. Each collision also sent the division
 * a "Sinkronisasi Sheets gagal" message about a failure that was purely
 * self-inflicted.
 *
 * The cron offset in scheduler.ts stops that specific collision; this
 * stops the general case, including a run that overruns into the next
 * tick and the manual CLI being run while the scheduler is live.
 */
let syncInFlight = false;

/**
 * MEMBERS/DAILY_REPORTS/WEEKLY_SUMMARIES/date-tabs export — extracted from
 * scripts/sync-sheets.ts (2026-08-08) so it can run as a scheduled job, not
 * just a manual CLI. Found live 2026-08-10: this was built and verified
 * once by hand and never actually wired into the scheduler, so no date tab
 * or report row had synced since — the owner had to point this out from
 * the live spreadsheet, it wasn't caught by any test (nothing here is
 * covered by an automated test against a real Postgres, same reason
 * scheduler.ts's own registration wiring isn't — pg-boss needs real
 * LISTEN/NOTIFY, PGlite doesn't support it).
 */
export async function runReportsSync(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  db: AppDatabase,
  now: Date,
  backfillFrom: CalendarDay | null = null,
  backfillUntil: CalendarDay | null = null,
): Promise<ReportsSyncResult> {
  if (syncInFlight) return { syncedTabs: [], failedTabs: [], skipped: true };
  syncInFlight = true;
  try {
    return await runReportsSyncUnguarded(sheets, spreadsheetId, db, now, backfillFrom, backfillUntil);
  } finally {
    syncInFlight = false;
  }
}

async function runReportsSyncUnguarded(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  db: AppDatabase,
  now: Date,
  backfillFrom: CalendarDay | null,
  backfillUntil: CalendarDay | null,
): Promise<ReportsSyncResult> {
  const syncedTabs: string[] = [];
  const failedTabs: Array<{ tabName: string; message: string }> = [];

  await deleteTabIfExists(sheets, spreadsheetId, "REPORT_ITEMS");

  const fixedTabs = [
    { name: "MEMBERS", build: () => buildMembersRows(db), format: MEMBERS_FORMAT },
    { name: "DAILY_REPORTS", build: () => buildDailyReportsRows(db), format: DAILY_REPORTS_FORMAT },
    { name: "WEEKLY_SUMMARIES", build: () => buildWeeklySummariesRows(db), format: WEEKLY_SUMMARIES_FORMAT },
    { name: "REKAP MINGGUAN", build: () => buildWeeklyRecapRows(db), format: WEEKLY_RECAP_FORMAT },
    { name: "ALIRAN KERJA", build: () => buildWorkStreamsRows(db), format: WORK_STREAMS_FORMAT },
  ];
  await ensureTabsExist(sheets, spreadsheetId, fixedTabs.map((t) => t.name));
  for (const tab of fixedTabs) {
    try {
      const rows = await tab.build();
      await replaceTabContent(sheets, spreadsheetId, tab.name, rows);
      await ensureTabFormatting(sheets, spreadsheetId, tab.format, rows[0] ?? []);
      await db.insert(sheetsSyncEvents).values({ tabName: tab.name, direction: "export", status: "succeeded", detail: { rowCount: rows.length - 1 } });
      syncedTabs.push(tab.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.insert(sheetsSyncEvents).values({ tabName: tab.name, direction: "export", status: "failed", detail: { message } });
      failedTabs.push({ tabName: tab.name, message });
    }
  }

  const today = calendarDayOf(now);
  const days = computeSyncDays(today, backfillFrom, backfillUntil);

  for (const day of days) {
    const tabName = dateTabName(day);
    assertNotReservedTabName(tabName);

    // Paced regardless of outcome — including a retry's own successful
    // attempt — so a long backfill doesn't re-accelerate straight back
    // into the same quota wall it just backed off from.
    if (syncedTabs.length + failedTabs.length > 0) await delay(INTER_TAB_DELAY_MS);

    let lastError: unknown;
    let succeeded = false;
    for (let attempt = 0; attempt <= MAX_QUOTA_RETRIES; attempt++) {
      try {
        const { rows, nameMergeBlocks } = await buildDateTabRows(db, day);
        const rowCount = rows.length + 5;
        const columnCount = DATE_TAB_HEADER.length;

        await ensureSizedTabExists(sheets, spreadsheetId, tabName, rowCount, columnCount);
        const sheetId = await getSheetId(sheets, spreadsheetId, tabName);

        await resetDateTabLayout(sheets, spreadsheetId, sheetId);
        await replaceTabContent(sheets, spreadsheetId, tabName, [DATE_TAB_HEADER, ...rows]);
        await applyDateTabFormatting(sheets, spreadsheetId, tabName, DATE_TAB_HEADER, nameMergeBlocks);

        await db.insert(sheetsSyncEvents).values({ tabName, direction: "export", status: "succeeded", detail: { rowCount: rows.length } });
        syncedTabs.push(tabName);
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;
        // Only quota errors retry — anything else (a malformed row, a
        // permissions error) would fail identically however many times
        // it's repeated, same reasoning as llm/client.ts's transient-HTTP
        // retry split.
        if (!isQuotaExceededError(error) || attempt === MAX_QUOTA_RETRIES) break;
        await delay(QUOTA_RETRY_BASE_MS * (attempt + 1));
      }
    }

    if (!succeeded) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      await db.insert(sheetsSyncEvents).values({ tabName, direction: "export", status: "failed", detail: { message } });
      failedTabs.push({ tabName, message });
    }
  }

  return { syncedTabs, failedTabs };
}

export function formatReportsSyncFailureNotice(result: ReportsSyncResult): string | null {
  if (result.failedTabs.length === 0) return null;
  return `Sinkronisasi Sheets gagal untuk ${result.failedTabs.length} tab: ${result.failedTabs.map((f) => f.tabName).join(", ")}. Cek log untuk detail.`;
}
