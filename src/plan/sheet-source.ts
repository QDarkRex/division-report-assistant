import { google, type sheets_v4 } from "googleapis";
import { quoteA1SheetName } from "../sheets/client.ts";
import type { RawCell, RawGrid } from "./parse.ts";

/**
 * The plan spreadsheet belongs to the supervisor. The bot may read it and
 * must never be able to change it — not by a bug, not by a future edit to
 * this folder. That is enforced three independent ways:
 *
 *  1. The credential: the JWT is minted with ONLY the readonly scope, so
 *     Google rejects any write regardless of what the code asks for.
 *  2. The type: everything in src/plan/ takes a `ReadOnlySheets`, which
 *     exposes `spreadsheets.get` and `spreadsheets.values.get|batchGet` and
 *     nothing else, so a write call does not compile.
 *  3. A test statically scans src/plan/*.ts for any other Sheets method.
 *
 * Do not reuse sheets/client.ts's createSheetsClient here: it requests the
 * read-write scope for the bot's OWN spreadsheet.
 */
export const PLAN_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export type ReadOnlySheets = {
  spreadsheets: Pick<sheets_v4.Resource$Spreadsheets, "get"> & {
    values: Pick<sheets_v4.Resource$Spreadsheets$Values, "get" | "batchGet">;
  };
};

/** Exposed separately from the client so a test can assert the exact scope list. */
export function createReadOnlyAuth(serviceAccountKeyJson: string) {
  const credentials = JSON.parse(serviceAccountKeyJson) as { client_email: string; private_key: string };
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [PLAN_READONLY_SCOPE],
  });
}

export function createReadOnlySheetsClient(serviceAccountKeyJson: string): ReadOnlySheets {
  return google.sheets({ version: "v4", auth: createReadOnlyAuth(serviceAccountKeyJson) });
}

/** Far more rows than any plan has, bounded so a 1000-row empty grid is not downloaded on every run. */
const MAX_ROWS = 1000;
const LAST_COLUMN = "Z";

/**
 * Fetches the plan tab as ONE snapshot carrying both renderings of every
 * cell (`formattedValue` and `effectiveValue`), via spreadsheets.get with
 * includeGridData.
 *
 * The alternative was two values.get calls (FORMATTED_VALUE for the ID and
 * text, UNFORMATTED_VALUE + SERIAL_NUMBER for dates and progress). That
 * works, but it is two reads at two moments: an edit landing between them
 * misaligns rows, and a shifted row would be silently misattributed to the
 * wrong ID. One request cannot tear. The field mask keeps the payload to
 * the two values per cell.
 */
export async function fetchPlanGrid(sheets: ReadOnlySheets, spreadsheetId: string, sheetName: string): Promise<RawGrid> {
  const { data } = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`${quoteA1SheetName(sheetName)}!A1:${LAST_COLUMN}${MAX_ROWS}`],
    includeGridData: true,
    fields: "sheets(properties(title),data(rowData(values(formattedValue,effectiveValue))))",
  });

  const sheet = (data.sheets ?? []).find((s) => s.properties?.title === sheetName) ?? data.sheets?.[0];
  if (!sheet) throw new Error(`plan tab "${sheetName}" not found in spreadsheet`);

  const rowData = sheet.data?.[0]?.rowData ?? [];
  return rowData.map((row) => (row.values ?? []).map(toRawCell));
}

function toRawCell(cell: sheets_v4.Schema$CellData): RawCell {
  const effective = cell.effectiveValue;
  let value: RawCell["value"] = null;
  if (effective) {
    if (typeof effective.numberValue === "number") value = effective.numberValue;
    else if (typeof effective.stringValue === "string") value = effective.stringValue;
    else if (typeof effective.boolValue === "boolean") value = effective.boolValue;
  }
  return { formatted: cell.formattedValue ?? null, value };
}
