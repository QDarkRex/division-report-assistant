import { eq, inArray } from "drizzle-orm";
import type { sheets_v4 } from "googleapis";
import type { AppDatabase } from "../db/types.ts";
import { dailyReports, members, projects, reportItems, reportRevisions, tasks } from "../db/schema.ts";
import type { CalendarDay } from "../shared/time.ts";
import { formatCalendarDay, fromJakartaWallClock, toJakartaWallClock } from "../shared/time.ts";
import { getAttendanceExpectations, getPartialAttendance, type AttendanceExpectation } from "../members/attendance.ts";
import {
  buildColumnRequests,
  getExistingBandedRangeIds,
  getExistingConditionalFormatCount,
  getSheetId,
  HEADER_BG,
  HEADER_BORDER,
  HEADER_FG,
  hexToRgb,
  STATUS_ITEM_RULES,
} from "./formatting.ts";

/**
 * Report Sheets redesign (Opus design review, 2026-08-08), owner-requested
 * departure from MASTER_SPEC.md §18's original "don't create one tab per
 * date" — owner explicitly wants per-date tabs for readability/portability
 * and has been told the tradeoffs; this is their call, not a mistake being
 * corrected. Scoped to reports only — MEMBERS stays type-based (member
 * identity isn't daily data).
 */

const DAY_ABBREV = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"] as const;

/**
 * Day-of-week via noon-Jakarta UTC instant, NOT Date.getDay() (UTC-based —
 * exactly the bug class that already corrupted data once in this project
 * today, see reprocess-message.ts's fix). fromJakartaWallClock(...,12)
 * is the same noon-anchoring trick addCalendarDays already uses.
 */
function dayAbbreviation(day: CalendarDay): string {
  const noonInstant = fromJakartaWallClock(day.year, day.month, day.day, 12);
  return DAY_ABBREV[noonInstant.getUTCDay()] ?? "?";
}

/** `YYYY-MM-DD Ddd`, e.g. "2026-08-08 Sab" — ISO prefix sorts correctly, day name makes it scannable. */
export function dateTabName(day: CalendarDay): string {
  return `${formatCalendarDay(day)} ${dayAbbreviation(day)}`;
}

/**
 * Tab names that a generated date name must never collide with. Every
 * date name is unique by construction (derived from reportingDay), so the
 * real hazard this guards is a future naming-format change accidentally
 * producing a fixed tab's name — this assertion is what would catch that
 * before it silently clobbers MEMBERS.
 */
export const RESERVED_TAB_NAMES = new Set([
  "MEMBERS",
  "DAILY_REPORTS",
  "REPORT_ITEMS",
  "TASKS",
  "TASK_ASSIGNEES",
  "TASK_HISTORY",
  "DASHBOARD",
  "DAILY_SUMMARIES",
  "WEEKLY_SUMMARIES",
  "PROJECTS",
  "SETTINGS",
  "SYNC_LOG",
  "ROSTER_MAPPING",
]);

export function assertNotReservedTabName(tabName: string): void {
  if (RESERVED_TAB_NAMES.has(tabName)) {
    throw new Error(`generated date tab name "${tabName}" collides with a reserved fixed tab name`);
  }
}

export const DATE_TAB_HEADER = ["Nama", "Proyek", "Aktivitas", "Hasil", "Kendala", "Status", "Jam Lapor", "Lembur", "Keterangan"];

/**
 * What a leave day reads as in the Aktivitas column. Plain words, no em
 * dashes — unlike the "— belum lapor —" placeholder these describe a real,
 * declared state rather than the absence of one, and the owner asked for
 * them written exactly this plainly.
 */
const LEAVE_LABELS: Record<string, string> = {
  izin: "izin",
  cuti: "cuti",
  sakit: "sakit",
  not_scheduled: "tidak dijadwalkan",
};

/**
 * What an empty row says. "belum lapor" is a reproach — it only belongs on
 * someone who actually owed a report. Owner, 2026-08-29: outside magang,
 * Saturday attendance is not required, so a quiet Saturday reads "tidak
 * masuk" until that member reports or says they are coming in.
 */
function absenceLabelFor(expectation: AttendanceExpectation | undefined): string {
  if (!expectation || expectation.expected) return "— belum lapor —";
  if (expectation.reason === "saturday_off") return "tidak masuk";
  const label = LEAVE_LABELS[expectation.kind] ?? expectation.kind;
  // The reason is optional by design (owner, 2026-08-29: "tidak wajib tapi
  // harus ada tempatnya"), so the label has to read correctly with and
  // without it — never a trailing dash on an empty explanation.
  //
  // Including the reason here is a DELIBERATE departure from MASTER_SPEC.md
  // §18, which bars "private health/family reasons" from the spreadsheet.
  // That rule exists for one stated reason — the viewer link may be
  // forwarded — and the owner has confirmed (2026-08-29) this spreadsheet
  // is shared only with admins and senior staff, so the premise does not
  // hold here. Recorded rather than left implicit: a future reader finding
  // "sakit — diare" in a sheet would otherwise read it as the §18
  // violation it looks like, and revert it. If the sharing scope ever
  // widens, this is the line to revisit first.
  return expectation.note ? `${label} — ${expectation.note}` : label;
}

function formatJakartaTime(instant: Date): string {
  const w = toJakartaWallClock(instant);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

export interface DateTabResult {
  rows: string[][];
  /** [startDataRowIndex, endDataRowIndexInclusive] pairs, 0-based into `rows`, for members with >1 row — the caller adds +1 for the header row when building a Sheets GridRange. Single-row blocks are omitted (a 1-row merge is a no-op request that should never be sent). */
  nameMergeBlocks: Array<[number, number]>;
}

/**
 * Builds one date tab's full row set. Report-item counting matches the
 * existing DAILY_REPORTS export's convention (export.ts): items from ALL
 * revisions of a report are shown, not just the latest — corrections are
 * modeled as additive in this system, not replacing, and this stays
 * consistent with that rather than introducing a new interpretation.
 */
export async function buildDateTabRows(db: AppDatabase, day: CalendarDay): Promise<DateTabResult> {
  const reportingDayLabel = formatCalendarDay(day);

  const reports = await db.select().from(dailyReports).where(eq(dailyReports.reportingDay, reportingDayLabel));
  // A member can now have two reports on one day — the regular end-of-day
  // one and an overtime (lembur) one — so they are grouped by kind, not
  // collapsed to one per member.
  type DayReport = (typeof reports)[number];
  const reportsByMember = new Map<string, { regular?: DayReport; overtime?: DayReport }>();
  for (const report of reports) {
    const entry = reportsByMember.get(report.memberId) ?? {};
    entry[report.kind] = report;
    reportsByMember.set(report.memberId, entry);
  }

  const activeMembers = await db
    .select()
    .from(members)
    .where(eq(members.membershipStatus, "active"));

  // Two groups, and the difference matters.
  //
  // Currently-active members owe a report, so they get a row whether or
  // not one exists — an empty one reads "— belum lapor —".
  //
  // Anyone else who ACTUALLY filed a report that day is included too, and
  // only then. Before 2026-09-06 the tab was built from active members
  // alone, which meant a date tab silently rewrote itself the moment
  // somebody left: marking Yudha resigned erased all 18 days of his work
  // from the spreadsheet, and Hafiz's and four other members' before him.
  // The reports were never lost — they sat in the database the whole time
  // — but the spreadsheet is what the admins actually read, so from where
  // they sit the work had simply never happened.
  //
  // Departed members are NOT given an empty row: they owed nothing once
  // they left, and back-filling "belum lapor" across every tab since would
  // invent an absence nobody claimed.
  const departedReporters = reports.length > 0
    ? await db
        .select()
        .from(members)
        .where(inArray(members.memberId, reports.map((r) => r.memberId)))
    : [];

  const byId = new Map<string, typeof activeMembers[number]>();
  for (const member of activeMembers.filter((m) => m.reportRequired)) byId.set(member.memberId, member);
  for (const member of departedReporters) byId.set(member.memberId, member);
  const reportRequiredMembers = [...byId.values()].sort((a, b) => a.preferredName.localeCompare(b.preferredName));

  // Owner request (2026-08-12): a member on leave should read "cuti" /
  // "izin" / "sakit" in the Aktivitas column instead of "— belum lapor —",
  // which made a legitimate absence indistinguishable from ignoring the
  // bot. `day` here is a reporting day, which is exactly the key leave is
  // checked against everywhere else.
  const expectations = await getAttendanceExpectations(db, day);

  // telat / pulang_cepat for the Keterangan column. These are NOT
  // absences — the member is present and still owes a report — so they are
  // fetched separately from the expectation and shown alongside the work.
  const partial = await getPartialAttendance(db, day);

  const reportIds = reports.map((r) => r.reportId);
  const revisions = reportIds.length > 0 ? await db.select().from(reportRevisions).where(inArray(reportRevisions.reportId, reportIds)) : [];
  const revisionsByReportId = new Map<string, typeof revisions>();
  for (const rev of revisions) {
    const list = revisionsByReportId.get(rev.reportId) ?? [];
    list.push(rev);
    revisionsByReportId.set(rev.reportId, list);
  }

  const revisionIds = revisions.map((r) => r.revisionId);
  const items = revisionIds.length > 0 ? await db.select().from(reportItems).where(inArray(reportItems.revisionId, revisionIds)) : [];
  const itemsByRevisionId = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByRevisionId.get(item.revisionId) ?? [];
    list.push(item);
    itemsByRevisionId.set(item.revisionId, list);
  }
  const revisionById = new Map(revisions.map((r) => [r.revisionId, r]));

  const taskIds = [...new Set(items.map((i) => i.taskId).filter((id): id is string => id !== null))];
  const taskRows = taskIds.length > 0 ? await db.select().from(tasks).where(inArray(tasks.taskId, taskIds)) : [];
  const taskById = new Map(taskRows.map((t) => [t.taskId, t]));
  // Every project, not only those reachable through a task: an item can
  // now carry its own projectId.
  const allProjectRows = await db.select().from(projects);
  const allProjectNameById = new Map(allProjectRows.map((p) => [p.projectId, p.name]));

  /**
   * report_items.projectId first: it is the attribution that was actually
   * decided (backfilled 2026-08-31, or set at ingest), and it survives
   * even when the item matches no task — which is nearly always, since 5
   * of 397 items ever matched one.
   *
   * The old fallback called resolveProjectsByNameOrAlias on the raw
   * activity, which does an EXACT ilike: "Soldering PCB BMS Epsilon"
   * never equalled the project "Epsilon", so this column rendered empty
   * for every item without a task. Dropped rather than kept as a
   * last resort — an exact match on a whole sentence can only ever succeed
   * by accident.
   */
  function resolveProjectName(itemProjectId: string | null, taskId: string | null): string {
    if (itemProjectId) {
      const name = allProjectNameById.get(itemProjectId);
      if (name) return name;
    }
    if (taskId) {
      const task = taskById.get(taskId);
      if (task?.projectId) return allProjectNameById.get(task.projectId) ?? "";
    }
    return "";
  }

  const rows: string[][] = [];
  const nameMergeBlocks: Array<[number, number]> = [];

  // The last column marks a row as overtime. Empty for regular work; the
  // owner asked for it written this plainly.
  const OVERTIME_MARK = "ya";

  // What the Lembur column shows for an overtime report: the time range the
  // member stated, or the bare mark when they gave no times. Verbatim —
  // "17:00–21:00", "mulai 17:00", "…–21:00".
  const overtimeMark = (report: DayReport): string => {
    const start = report.overtimeStartText?.trim();
    const end = report.overtimeEndText?.trim();
    if (start && end) return `${start}–${end}`;
    if (start) return `mulai ${start}`;
    if (end) return `…–${end}`;
    return OVERTIME_MARK;
  };

  // telat / pulang_cepat rendered for the Keterangan column.
  const PARTIAL_LABELS: Record<string, string> = { telat: "telat", pulang_cepat: "pulang cepat" };
  const keteranganFor = (memberId: string): string => {
    const p = partial.get(memberId);
    if (!p) return "";
    const label = PARTIAL_LABELS[p.kind] ?? p.kind;
    return p.note ? `${label} — ${p.note}` : label;
  };

  // Renders one report's rows into `rows`. Shared by the regular and the
  // overtime section so a lembur report is laid out exactly like a normal
  // one — same revisions-flattened item list, same "— tidak ada aktivitas —"
  // and empty-report handling — differing only in the trailing mark.
  const pushReportRows = (name: string, report: DayReport, isOvertime: boolean): void => {
    const mark = isOvertime ? overtimeMark(report) : "";
    if (report.noActivity) {
      rows.push([name, "", "— tidak ada aktivitas —", "", "", "", formatJakartaTime(report.createdAt), mark, ""]);
      return;
    }
    const memberRevisions = (revisionsByReportId.get(report.reportId) ?? []).sort((a, b) => a.revisionNumber - b.revisionNumber);
    const memberItems = memberRevisions.flatMap((rev) => itemsByRevisionId.get(rev.revisionId) ?? []);
    if (memberItems.length === 0) {
      // An overtime report with no items yet is a check-in ("absen lembur")
      // whose work has not arrived — nag it rather than hide it, the same
      // discipline the regular "belum lapor" row follows.
      const placeholder = isOvertime ? "lembur — belum lapor" : "— tidak ada aktivitas —";
      rows.push([name, "", placeholder, "", "", "", formatJakartaTime(report.createdAt), mark, ""]);
      return;
    }
    for (const item of memberItems) {
      const revision = revisionById.get(item.revisionId);
      const jamLapor = revision ? formatJakartaTime(revision.createdAt) : "";
      const project = resolveProjectName(item.projectId, item.taskId);
      rows.push([name, project, item.activity, item.result ?? "", item.obstacle ?? "", item.status, jamLapor, mark, ""]);
    }
  };

  for (const member of reportRequiredMembers) {
    const startRow = rows.length;
    const reports = reportsByMember.get(member.memberId) ?? {};
    const expectation = expectations.get(member.memberId);

    // Regular section. The absence/"belum lapor" placeholder is about the
    // REGULAR obligation only — §14 lets a member who is away report
    // anyway, and if they did, their work is the more useful thing to show.
    //
    // One exception, added 2026-09-12: a member who was NOT expected to file
    // a regular report (a staff+ on a Saturday, "tidak masuk") but DID file
    // an overtime report plainly came in. Printing "tidak masuk" above their
    // lembur work contradicts it. So when there is no regular report, an
    // overtime one, and no regular obligation, the placeholder is dropped
    // and only the overtime rows stand. A member who WAS expected still
    // reads "belum lapor" even with overtime — the overtime does not
    // discharge the regular report they still owe.
    const skipRegularPlaceholder = !reports.regular && reports.overtime !== undefined && expectation?.expected === false;
    if (reports.regular) {
      pushReportRows(member.preferredName, reports.regular, false);
    } else if (!skipRegularPlaceholder) {
      rows.push([member.preferredName, "", absenceLabelFor(expectation), "", "", "", "", "", ""]);
    }

    // Overtime section only appears when an overtime report exists — never
    // as an empty "expected" row. Nobody owes overtime.
    if (reports.overtime) {
      pushReportRows(member.preferredName, reports.overtime, true);
    }

    // Keterangan (telat / pulang cepat) is a fact about the member's day,
    // so it goes once, on the first row of their block — like the merged
    // name — not repeated on every item row.
    const keterangan = keteranganFor(member.memberId);
    const firstRow = rows[startRow];
    if (keterangan && firstRow) firstRow[firstRow.length - 1] = keterangan;

    const endRow = rows.length - 1;
    if (endRow > startRow) nameMergeBlocks.push([startRow, endRow]);
  }

  return { rows, nameMergeBlocks };
}

const BLOCK_TINT_A = "#FFFFFF";
const BLOCK_TINT_B = "#F5F7FA";
const NAME_COLUMN_INDEX = 0;

/**
 * MUST run before values.clear()/values.update() on every sync. Merges
 * are cell metadata, NOT cleared by values.clear() — if yesterday's merge
 * from a larger row count survives into today's values.update(), Sheets
 * silently keeps only the merged range's top-left value and DISCARDS
 * every value written underneath it. The tab looks populated, the data is
 * wrong, Postgres is correct, and nothing anywhere alerts. Block shading
 * is reset here too (repeatCell survives values.clear() the same way
 * merges do) so yesterday's block boundaries can't bleed into today's.
 */
export async function resetDateTabLayout(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetId: number): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { unmergeCells: { range: { sheetId } } },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1 },
            cell: { userEnteredFormat: { backgroundColor: hexToRgb(BLOCK_TINT_A) } },
            fields: "userEnteredFormat.backgroundColor",
          },
        },
      ],
    },
  });
}

const DATE_TAB_COLUMNS: Array<{ header: string; widthPx: number; wrap?: boolean; align?: "LEFT" | "CENTER" }> = [
  { header: "Nama", widthPx: 150 },
  { header: "Proyek", widthPx: 160 },
  { header: "Aktivitas", widthPx: 360, wrap: true },
  { header: "Hasil", widthPx: 300, wrap: true },
  { header: "Kendala", widthPx: 260, wrap: true },
  { header: "Status", widthPx: 110, align: "CENTER" },
  { header: "Jam Lapor", widthPx: 80, align: "CENTER" },
  { header: "Lembur", widthPx: 110, align: "CENTER" },
  { header: "Keterangan", widthPx: 180 },
];

/**
 * Applies header/column formatting, then block shading and Nama merges
 * for `nameMergeBlocks` (from buildDateTabRows, 0-based into the data
 * rows — +1 applied here for the header row offset). Call AFTER
 * resetDateTabLayout() and the values write, per the ordering in this
 * file's other doc comments — merging before the write risks the same
 * silent-data-loss failure mode resetDateTabLayout() exists to prevent.
 * No row banding here (block shading replaces it — banding stripes and
 * vertical merges fight, the stripes stop aligning with member blocks).
 */
export async function applyDateTabFormatting(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabName: string,
  headerRow: string[],
  nameMergeBlocks: Array<[number, number]>,
): Promise<void> {
  const sheetId = await getSheetId(sheets, spreadsheetId, tabName);

  const teardown: sheets_v4.Schema$Request[] = [];
  const existingCfCount = await getExistingConditionalFormatCount(sheets, spreadsheetId, sheetId);
  for (let i = 0; i < existingCfCount; i++) teardown.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
  const existingBandIds = await getExistingBandedRangeIds(sheets, spreadsheetId, sheetId);
  for (const bandedRangeId of existingBandIds) teardown.push({ deleteBanding: { bandedRangeId } });
  if (teardown.length > 0) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: teardown } });

  const statusColumns = DATE_TAB_COLUMNS.map((c) => (c.header === "Status" ? { ...c, rules: STATUS_ITEM_RULES } : c));

  const requests: sheets_v4.Schema$Request[] = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
        fields: "gridProperties(frozenRowCount,frozenColumnCount)",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 36 },
        fields: "pixelSize",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { fontFamily: "Roboto", fontSize: 10, foregroundColor: hexToRgb("#202124") },
            verticalAlignment: "TOP",
            wrapStrategy: "CLIP",
          },
        },
        fields: "userEnteredFormat(textFormat,verticalAlignment,wrapStrategy)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexToRgb(HEADER_BG),
            textFormat: { fontFamily: "Roboto", fontSize: 10, bold: true, foregroundColor: hexToRgb(HEADER_FG) },
            horizontalAlignment: "LEFT",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
            padding: { top: 6, bottom: 6, left: 8, right: 8 },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,padding)",
      },
    },
    {
      updateBorders: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        bottom: { style: "SOLID_MEDIUM", color: hexToRgb(HEADER_BORDER) },
      },
    },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0 } } } },
    ...buildColumnRequests(sheetId, statusColumns, headerRow),
  ];

  nameMergeBlocks.forEach(([start, end], blockIndex) => {
    const tint = blockIndex % 2 === 0 ? BLOCK_TINT_A : BLOCK_TINT_B;
    const sheetStartRow = start + 1; // +1 for the header row
    const sheetEndRow = end + 2; // +1 header, +1 exclusive end
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: sheetStartRow, endRowIndex: sheetEndRow },
        cell: { userEnteredFormat: { backgroundColor: hexToRgb(tint) } },
        fields: "userEnteredFormat.backgroundColor",
      },
    });
    requests.push({
      mergeCells: {
        range: { sheetId, startRowIndex: sheetStartRow, endRowIndex: sheetEndRow, startColumnIndex: NAME_COLUMN_INDEX, endColumnIndex: NAME_COLUMN_INDEX + 1 },
        mergeType: "MERGE_ALL",
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: sheetStartRow, endRowIndex: sheetEndRow, startColumnIndex: NAME_COLUMN_INDEX, endColumnIndex: NAME_COLUMN_INDEX + 1 },
        cell: { userEnteredFormat: { verticalAlignment: "MIDDLE", textFormat: { bold: true } } },
        fields: "userEnteredFormat(verticalAlignment,textFormat.bold)",
      },
    });
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}
