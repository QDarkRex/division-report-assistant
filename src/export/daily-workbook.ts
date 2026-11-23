import ExcelJS from "exceljs";
import { eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { dailyReports } from "../db/schema.ts";
import { buildDateTabRows, DATE_TAB_HEADER, dateTabName } from "../sheets/date-tabs.ts";
import { formatCalendarDay, type CalendarDay } from "../shared/time.ts";

/**
 * One reporting day as a single-sheet .xlsx.
 *
 * Owner request 2026-09-08: the division's report has to reach the boss's
 * assistant through Sena, a Telegram agent that accepts a spreadsheet. The
 * requirement was explicit that a day's file contains only that day — "misal
 * report tanggal 8 september ya hanya kirim 1 sheet yang berisi report 8
 * september bukan semuanya". Forwarding the whole live spreadsheet would
 * hand a third party every day the division has ever worked, and every
 * member's leave reason with it.
 *
 * Deliberately reuses buildDateTabRows rather than querying again. That
 * function already carries every rule this output must not contradict: who
 * is expected to report, how leave and Saturdays are rendered, that a
 * departed member keeps the days they worked, and which project an item
 * belongs to. A second query here would be a second, quietly diverging
 * definition of what a day's report is.
 */
export interface DailyWorkbook {
  buffer: Buffer;
  fileName: string;
  /** Rows of actual content, header excluded. */
  rowCount: number;
  /**
   * How many members actually filed something that day.
   *
   * Not the same as rowCount, and the difference is the whole point: a day
   * nobody reported on still produces a full grid of "— belum lapor —"
   * rows, one per active member. Sending that onward would tell the boss's
   * assistant the division did nothing, when the truth is only that the
   * reports have not come in yet. The caller refuses on this number.
   */
  reportCount: number;
}

export async function buildDailyWorkbook(db: AppDatabase, day: CalendarDay): Promise<DailyWorkbook> {
  const { rows } = await buildDateTabRows(db, day);
  const tabName = dateTabName(day);

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(tabName);

  sheet.addRow([...DATE_TAB_HEADER]);
  for (const row of rows) sheet.addRow(row);

  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  // Widths sized to the content, capped: an obstacle field can run to a
  // paragraph, and a 400-character column makes the sheet unreadable.
  sheet.columns = DATE_TAB_HEADER.map((header, index) => {
    const longest = rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), header.length);
    return { width: Math.min(Math.max(longest + 2, 10), 60) };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: DATE_TAB_HEADER.length } };

  const [reportRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dailyReports)
    .where(eq(dailyReports.reportingDay, formatCalendarDay(day)));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName: `Laporan Divisi Listrik ${tabName}.xlsx`,
    rowCount: rows.length,
    reportCount: reportRow?.count ?? 0,
  };
}
