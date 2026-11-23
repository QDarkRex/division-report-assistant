import type { sheets_v4 } from "googleapis";

/**
 * Formatting spec designed via an Opus escalation (2026-08-07), requested
 * explicitly by the owner ("format ulang spreadsheet agar lebih
 * professional dan mudah dibaca"). Ground rules from that design, load-
 * bearing for correctness:
 *
 * - Cell formatting (repeatCell) survives values.clear/values.update —
 *   applied once, not reapplied per sync.
 * - Conditional-format rules and banded ranges do NOT dedupe on
 *   re-application — every call to ensureTabFormatting() deletes existing
 *   conditional formats and bandings for the sheet first, then re-adds.
 *   This makes it safe to call on every sync run without accumulating
 *   duplicates.
 * - Column indices are resolved from the tab's actual header row (passed
 *   in), not hardcoded — a column inserted later doesn't silently
 *   misapply formatting to the wrong column.
 * - One correction to the Opus design as delivered: it labeled
 *   DAILY_REPORTS's "Revisi Terakhir" column as DATE_TIME formatting —
 *   that column is `revisionNumber` (an integer), not a date. Formatted
 *   as NUMBER here instead.
 */

const PALETTE = {
  BLUE: { bg: "#E3F2FD", fg: "#0D47A1" },
  AMBER: { bg: "#FFF8E1", fg: "#8A5300" },
  PURPLE: { bg: "#EDE7F6", fg: "#4527A0" },
  RED: { bg: "#FCE4E4", fg: "#B3261E" },
  GREEN: { bg: "#E6F4EA", fg: "#137333" },
  GRAY: { bg: "#F1F3F4", fg: "#5F6368" },
  ORANGE: { bg: "#FFF0E6", fg: "#A14100" },
} as const;

export const HEADER_BG = "#1E3A5F";
export const HEADER_FG = "#FFFFFF";
export const HEADER_BORDER = "#0F2440";
export const BODY_TEXT = "#202124";
export const MUTED_TEXT = "#5F6368";
const BAND_EVEN = "#FFFFFF";
const BAND_ODD = "#F5F7FA";

export function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

interface TextEqRule {
  kind: "TEXT_EQ";
  value: string;
  bg: keyof typeof PALETTE;
  bold?: boolean;
}
interface GradientRule {
  kind: "GRADIENT";
  minValue: number;
  maxValue: number;
  minHex: string;
  maxHex: string;
}
export type ColumnRule = TextEqRule | GradientRule;

export interface ColumnSpec {
  header: string;
  widthPx: number;
  align?: "LEFT" | "CENTER";
  bold?: boolean;
  wrap?: boolean;
  textColor?: string;
  numberFormat?: { type: string; pattern?: string };
  rules?: ColumnRule[];
}

export interface TabFormatSpec {
  tabName: string;
  freezeColumns: number;
  columns: ColumnSpec[];
}

const STATUS_KEANGGOTAAN_RULES: ColumnRule[] = [
  { kind: "TEXT_EQ", value: "pending", bg: "AMBER" },
  { kind: "TEXT_EQ", value: "active", bg: "GREEN" },
  { kind: "TEXT_EQ", value: "inactive", bg: "GRAY" },
  { kind: "TEXT_EQ", value: "transferred", bg: "BLUE" },
  { kind: "TEXT_EQ", value: "resigned", bg: "ORANGE" },
  { kind: "TEXT_EQ", value: "removed", bg: "RED" },
];

export const STATUS_ITEM_RULES: ColumnRule[] = [
  { kind: "TEXT_EQ", value: "worked_on", bg: "BLUE" },
  { kind: "TEXT_EQ", value: "in_progress", bg: "AMBER" },
  { kind: "TEXT_EQ", value: "testing", bg: "PURPLE" },
  { kind: "TEXT_EQ", value: "blocked", bg: "RED" },
  { kind: "TEXT_EQ", value: "done", bg: "GREEN" },
  { kind: "TEXT_EQ", value: "unknown", bg: "GRAY" },
];

export const MEMBERS_FORMAT: TabFormatSpec = {
  tabName: "MEMBERS",
  freezeColumns: 2,
  columns: [
    { header: "member_id", widthPx: 90, textColor: MUTED_TEXT, numberFormat: { type: "TEXT" } },
    { header: "Nama", widthPx: 170, bold: true },
    { header: "Peran", widthPx: 90, align: "CENTER", rules: [{ kind: "TEXT_EQ", value: "admin", bg: "PURPLE", bold: true }] },
    { header: "Status Keanggotaan", widthPx: 140, align: "CENTER", rules: STATUS_KEANGGOTAAN_RULES },
    { header: "Wajib Lapor", widthPx: 100, align: "CENTER", rules: [{ kind: "TEXT_EQ", value: "Tidak", bg: "GRAY" }] },
    { header: "Mulai", widthPx: 110, numberFormat: { type: "DATE", pattern: "dd mmm yyyy" } },
    { header: "Berakhir", widthPx: 110, numberFormat: { type: "DATE", pattern: "dd mmm yyyy" } },
    { header: "Diperbarui", widthPx: 150, textColor: MUTED_TEXT, numberFormat: { type: "DATE_TIME", pattern: "dd mmm yyyy hh:mm" } },
  ],
};

export const DAILY_REPORTS_FORMAT: TabFormatSpec = {
  tabName: "DAILY_REPORTS",
  freezeColumns: 2,
  columns: [
    { header: "Tanggal Lapor", widthPx: 110, numberFormat: { type: "DATE", pattern: "dd mmm yyyy" } },
    { header: "Nama", widthPx: 170, bold: true },
    { header: "Ada Aktivitas", widthPx: 110, align: "CENTER", rules: [{ kind: "TEXT_EQ", value: "Tidak", bg: "RED" }] },
    {
      header: "Jumlah Item",
      widthPx: 95,
      align: "CENTER",
      numberFormat: { type: "NUMBER", pattern: "0" },
      rules: [{ kind: "GRADIENT", minValue: 0, maxValue: 10, minHex: "#FFFFFF", maxHex: "#C8E6C9" }],
    },
    // Opus's draft mislabeled this as DATE_TIME — it's revisionNumber, an integer, not a date.
    { header: "Revisi Terakhir", widthPx: 110, align: "CENTER", textColor: MUTED_TEXT, numberFormat: { type: "NUMBER", pattern: "0" } },
    {
      header: "Menunggu Konfirmasi Admin",
      widthPx: 130,
      align: "CENTER",
      rules: [{ kind: "TEXT_EQ", value: "Ya", bg: "AMBER", bold: true }],
    },
    { header: "Dibuat", widthPx: 150, textColor: MUTED_TEXT, numberFormat: { type: "DATE_TIME", pattern: "dd mmm yyyy hh:mm" } },
  ],
};

export const REPORT_ITEMS_FORMAT: TabFormatSpec = {
  tabName: "REPORT_ITEMS",
  freezeColumns: 2,
  columns: [
    { header: "Tanggal Lapor", widthPx: 110, numberFormat: { type: "DATE", pattern: "dd mmm yyyy" } },
    { header: "Nama", widthPx: 150, bold: true },
    { header: "Judul Task", widthPx: 200, wrap: true },
    { header: "Aktivitas", widthPx: 340, wrap: true },
    { header: "Hasil", widthPx: 340, wrap: true },
    { header: "Ada Kendala", widthPx: 100, align: "CENTER", rules: [{ kind: "TEXT_EQ", value: "Ya", bg: "RED", bold: true }] },
    { header: "Status Item", widthPx: 120, align: "CENTER", rules: STATUS_ITEM_RULES },
    { header: "Dibuat", widthPx: 150, textColor: MUTED_TEXT, numberFormat: { type: "DATE_TIME", pattern: "dd mmm yyyy hh:mm" } },
  ],
};

export const WEEKLY_SUMMARIES_FORMAT: TabFormatSpec = {
  tabName: "WEEKLY_SUMMARIES",
  freezeColumns: 1,
  columns: [
    { header: "Minggu Mulai", widthPx: 110, numberFormat: { type: "DATE", pattern: "dd mmm yyyy" } },
    { header: "Provisional", widthPx: 90, align: "CENTER", rules: [{ kind: "TEXT_EQ", value: "Ya", bg: "AMBER" }] },
    { header: "Task Selesai", widthPx: 90, align: "CENTER" },
    { header: "Masih Overdue", widthPx: 100, align: "CENTER", rules: [{ kind: "GRADIENT", minValue: 0, maxValue: 10, minHex: "#FFFFFF", maxHex: "#FCE4E4" }] },
    { header: "Kendala", widthPx: 80, align: "CENTER" },
    { header: "Kepatuhan Lapor (%)", widthPx: 130, align: "CENTER", rules: [{ kind: "GRADIENT", minValue: 0, maxValue: 100, minHex: "#FCE4E4", maxHex: "#E6F4EA" }] },
    { header: "Project", widthPx: 200, wrap: true },
    { header: "Dikirim Pada", widthPx: 150, textColor: MUTED_TEXT },
  ],
};

export const WEEKLY_RECAP_FORMAT: TabFormatSpec = {
  tabName: "REKAP MINGGUAN",
  freezeColumns: 3,
  columns: [
    { header: "Pekan", widthPx: 100, numberFormat: { type: "DATE", pattern: "dd mmm yyyy" } },
    { header: "ID aliran", widthPx: 130, textColor: MUTED_TEXT },
    { header: "Nama aliran", widthPx: 240, bold: true, wrap: true },
    { header: "Butir", widthPx: 60, align: "CENTER" },
    { header: "Orang", widthPx: 200, wrap: true },
    { header: "Ringkasan", widthPx: 520, wrap: true },
    { header: "Tertahan", widthPx: 80, align: "CENTER", rules: [{ kind: "GRADIENT", minValue: 0, maxValue: 5, minHex: "#FFFFFF", maxHex: "#FCE4E4" }] },
    { header: "Hambatan", widthPx: 260, wrap: true },
    { header: "Δ vs pekan lalu", widthPx: 110, align: "CENTER" },
    { header: "Bukti (report_item id)", widthPx: 240, textColor: MUTED_TEXT, wrap: true },
  ],
};

export const WORK_STREAMS_FORMAT: TabFormatSpec = {
  tabName: "ALIRAN KERJA",
  freezeColumns: 1,
  columns: [
    { header: "ID aliran", widthPx: 160, textColor: MUTED_TEXT },
    { header: "Nama", widthPx: 380, bold: true, wrap: true },
    { header: "Nama pendek", widthPx: 200 },
    { header: "Asal", widthPx: 80, align: "CENTER" },
    { header: "Diarsipkan", widthPx: 90, align: "CENTER" },
  ],
};

const TASK_STATUS_RULES: ColumnRule[] = [
  { kind: "TEXT_EQ", value: "active", bg: "BLUE" },
  { kind: "TEXT_EQ", value: "active_unreviewed", bg: "AMBER" },
  { kind: "TEXT_EQ", value: "in_progress", bg: "AMBER" },
  { kind: "TEXT_EQ", value: "blocked", bg: "RED" },
  { kind: "TEXT_EQ", value: "paused", bg: "GRAY" },
  { kind: "TEXT_EQ", value: "stale", bg: "ORANGE" },
  { kind: "TEXT_EQ", value: "status_conflict", bg: "RED", bold: true },
  { kind: "TEXT_EQ", value: "done", bg: "GREEN" },
  { kind: "TEXT_EQ", value: "cancelled", bg: "GRAY" },
];

export const TASKS_FORMAT: TabFormatSpec = {
  tabName: "TASKS",
  freezeColumns: 2,
  columns: [
    { header: "task_id", widthPx: 90, textColor: MUTED_TEXT, numberFormat: { type: "TEXT" } },
    { header: "version", widthPx: 60, align: "CENTER", textColor: MUTED_TEXT, numberFormat: { type: "NUMBER", pattern: "0" } },
    { header: "Judul", widthPx: 220, bold: true, wrap: true },
    { header: "Proyek", widthPx: 150 },
    { header: "Status", widthPx: 120, align: "CENTER", rules: TASK_STATUS_RULES },
    { header: "Deadline", widthPx: 100, align: "CENTER" },
    { header: "Penanggung Jawab", widthPx: 180, wrap: true },
    { header: "Catatan Admin", widthPx: 220, wrap: true },
    { header: "Aktif", widthPx: 70, align: "CENTER", textColor: MUTED_TEXT, rules: [{ kind: "TEXT_EQ", value: "Tidak", bg: "GRAY" }] },
    { header: "Update Terakhir", widthPx: 220, wrap: true, textColor: MUTED_TEXT },
    { header: "Diperbarui", widthPx: 150, textColor: MUTED_TEXT },
  ],
};

export function columnIndex(headerRow: string[], header: string): number {
  const idx = headerRow.indexOf(header);
  if (idx === -1) throw new Error(`formatting spec references header "${header}" not present in the actual tab header row`);
  return idx;
}

export async function getSheetId(sheets: sheets_v4.Sheets, spreadsheetId: string, tabName: string): Promise<number> {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  const sheet = (data.sheets ?? []).find((s) => s.properties?.title === tabName);
  if (sheet?.properties?.sheetId === undefined || sheet.properties.sheetId === null) {
    throw new Error(`tab "${tabName}" not found in spreadsheet`);
  }
  return sheet.properties.sheetId;
}

export async function getExistingConditionalFormatCount(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetId: number): Promise<number> {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId),conditionalFormats)" });
  const sheet = (data.sheets ?? []).find((s) => s.properties?.sheetId === sheetId);
  return sheet?.conditionalFormats?.length ?? 0;
}

export async function getExistingBandedRangeIds(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetId: number): Promise<number[]> {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId),bandedRanges(bandedRangeId))" });
  const sheet = (data.sheets ?? []).find((s) => s.properties?.sheetId === sheetId);
  return (sheet?.bandedRanges ?? []).map((b) => b.bandedRangeId).filter((id): id is number => id !== undefined && id !== null);
}

export function buildColumnRequests(sheetId: number, columns: ColumnSpec[], headerRow: string[]): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];

  columns.forEach((col, specIndex) => {
    const colIndex = columnIndex(headerRow, col.header);

    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: colIndex, endIndex: colIndex + 1 },
        properties: { pixelSize: col.widthPx },
        fields: "pixelSize",
      },
    });

    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { fontFamily: "Roboto", fontSize: 10, bold: !!col.bold, foregroundColor: hexToRgb(col.textColor ?? BODY_TEXT) },
            horizontalAlignment: col.align ?? "LEFT",
            verticalAlignment: col.wrap ? "TOP" : "MIDDLE",
            wrapStrategy: col.wrap ? "WRAP" : "CLIP",
            ...(col.numberFormat ? { numberFormat: col.numberFormat } : {}),
          },
        },
        fields:
          "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment,wrapStrategy" +
          (col.numberFormat ? ",numberFormat" : "") +
          ")",
      },
    });

    for (const rule of col.rules ?? []) {
      const range = { sheetId, startRowIndex: 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 };
      if (rule.kind === "TEXT_EQ") {
        const tone = PALETTE[rule.bg];
        requests.push({
          addConditionalFormatRule: {
            index: 0,
            rule: {
              ranges: [range],
              booleanRule: {
                condition: { type: "TEXT_EQ", values: [{ userEnteredValue: rule.value }] },
                format: { backgroundColor: hexToRgb(tone.bg), textFormat: { foregroundColor: hexToRgb(tone.fg), bold: !!rule.bold } },
              },
            },
          },
        });
      } else {
        requests.push({
          addConditionalFormatRule: {
            index: 0,
            rule: {
              ranges: [range],
              gradientRule: {
                minpoint: { type: "NUMBER", value: String(rule.minValue), color: hexToRgb(rule.minHex) },
                maxpoint: { type: "NUMBER", value: String(rule.maxValue), color: hexToRgb(rule.maxHex) },
              },
            },
          },
        });
      }
    }

    void specIndex;
  });

  return requests;
}

/**
 * Applies header styling, freeze, banding, borders, filter, and all
 * per-column formatting/conditional-formatting for one tab. Safe to call
 * on every sync — deletes existing conditional formats and bandings for
 * this sheet first (they don't dedupe on re-add), then re-applies.
 */
export async function ensureTabFormatting(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  spec: TabFormatSpec,
  headerRow: string[],
): Promise<void> {
  const sheetId = await getSheetId(sheets, spreadsheetId, spec.tabName);

  const teardown: sheets_v4.Schema$Request[] = [];
  const existingCfCount = await getExistingConditionalFormatCount(sheets, spreadsheetId, sheetId);
  for (let i = 0; i < existingCfCount; i++) {
    teardown.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
  }
  const existingBandIds = await getExistingBandedRangeIds(sheets, spreadsheetId, sheetId);
  for (const bandedRangeId of existingBandIds) {
    teardown.push({ deleteBanding: { bandedRangeId } });
  }
  if (teardown.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: teardown } });
  }

  const requests: sheets_v4.Schema$Request[] = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: spec.freezeColumns } },
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
            textFormat: { fontFamily: "Roboto", fontSize: 10, foregroundColor: hexToRgb(BODY_TEXT) },
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
    {
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 1 },
          rowProperties: { firstBandColor: hexToRgb(BAND_EVEN), secondBandColor: hexToRgb(BAND_ODD) },
        },
      },
    },
    {
      setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0 } } },
    },
    ...buildColumnRequests(sheetId, spec.columns, headerRow),
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}
