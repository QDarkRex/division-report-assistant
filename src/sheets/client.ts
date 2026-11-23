import { google, sheets_v4 } from "googleapis";

/**
 * MASTER_SPEC.md §13: service account is the only writer. Credentials
 * live only in the secrets file on the deploy host, never in git — same
 * handling as LITELLM_API_KEY.
 */
export interface SheetsClientConfig {
  serviceAccountKeyJson: string;
  spreadsheetId: string;
}

export function createSheetsClient(config: SheetsClientConfig): sheets_v4.Sheets {
  const credentials = JSON.parse(config.serviceAccountKeyJson) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

/** Deletes a tab if it exists; no-op if it doesn't. Used once to retire REPORT_ITEMS in favor of per-date tabs. */
export async function deleteTabIfExists(sheets: sheets_v4.Sheets, spreadsheetId: string, tabName: string): Promise<void> {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  const sheet = (data.sheets ?? []).find((s) => s.properties?.title === tabName);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ deleteSheet: { sheetId } }] } });
}

/** Creates any of `tabNames` that don't already exist in the spreadsheet as a sheet/tab. */
export async function ensureTabsExist(sheets: sheets_v4.Sheets, spreadsheetId: string, tabNames: string[]): Promise<void> {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set((data.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => !!t));
  const missing = tabNames.filter((name) => !existing.has(name));
  if (missing.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
  });
}

/**
 * A1 range syntax requires a sheet name containing a space (or other
 * special character) to be single-quoted, e.g. `'2026-08-08 Sab'!A1` —
 * unquoted, the space breaks range parsing. Doubling embedded single
 * quotes is the A1 escaping rule for a literal `'` in a sheet name.
 */
export function quoteA1SheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export async function getSheetIdByName(sheets: sheets_v4.Sheets, spreadsheetId: string, tabName: string): Promise<number> {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  const sheet = (data.sheets ?? []).find((s) => s.properties?.title === tabName);
  if (sheet?.properties?.sheetId === undefined || sheet.properties.sheetId === null) {
    throw new Error(`tab "${tabName}" not found in spreadsheet`);
  }
  return sheet.properties.sheetId;
}

/**
 * Creates a tab with an EXPLICIT small grid instead of Sheets' default
 * 1000x26 (26,000 cells). A spreadsheet caps at 10M cells total — 365
 * naive-default date tabs in a year would be 365 * 26,000 = 9.49M cells,
 * hitting the cap inside a single year (Opus design review, 2026-08-08).
 * Idempotent: shrinks/grows an existing date tab's grid to match
 * `rowCount` on every call rather than erroring if it already exists.
 */
export async function ensureSizedTabExists(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabName: string,
  rowCount: number,
  columnCount: number,
): Promise<void> {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  const titles = (data.sheets ?? []).map((s) => s.properties?.title ?? "");
  const existing = (data.sheets ?? []).find((s) => s.properties?.title === tabName);

  if (!existing) {
    // Place a new date tab at its chronological position rather than
    // letting it append to the end. The date-tab title format
    // ("YYYY-MM-DD Ddd") sorts lexically the same as chronologically, so a
    // new tab belongs after every non-date tab and after every date tab
    // whose title is smaller. Without this, tabs created in later sync runs
    // pile up at the far right in creation order — by 2026-09-12 that had
    // scattered 158 tabs so badly the owner could not find 11-14 September
    // among the December ones. The one-off reorder that unstuck them only
    // fixed the past; this keeps it fixed.
    const isDateTab = (t: string) => /^\d{4}-\d{2}-\d{2}/.test(t);
    const index = isDateTab(tabName)
      ? titles.filter((t) => !isDateTab(t)).length + titles.filter((t) => isDateTab(t) && t < tabName).length
      : titles.length;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName, index, gridProperties: { rowCount, columnCount } } } }] },
    });
    return;
  }

  const sheetId = existing.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { rowCount, columnCount } },
            fields: "gridProperties(rowCount,columnCount)",
          },
        },
      ],
    },
  });
}

/**
 * Replaces a tab's entire content (header row included) with `rows`.
 * MASTER_SPEC.md §13 frames one-way tabs as "append-only," but at this
 * project's data volume (dozens to low hundreds of rows) a full replace
 * on every sync is simpler and always correct — no watermark/dedup state
 * to get wrong. Revisit only if row counts grow enough for this to matter.
 *
 * USER_ENTERED (not RAW): date/datetime strings written as
 * "2026-08-07"/"2026-08-07 15:38" need Sheets to actually parse them as
 * dates for formatting.ts's DATE/DATE_TIME numberFormat to have any
 * effect — under RAW they'd stay plain text and the format would be a
 * silent no-op. Plain strings ("Ya"/"Tidak", status enum values, names)
 * are not reinterpreted by USER_ENTERED, only things that look like
 * numbers/dates/formulas are.
 */
export async function replaceTabContent(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabName: string,
  rows: string[][],
): Promise<void> {
  const quoted = quoteA1SheetName(tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: quoted });
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoted}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

/** Removes every merge in a sheet — MUST run before values.clear()/values.update() on a
 * date tab whose row layout may have shrunk since the last sync (see mergeNameCells doc). */
export async function unmergeAllCells(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetId: number): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ unmergeCells: { range: { sheetId } } }] },
  });
}
