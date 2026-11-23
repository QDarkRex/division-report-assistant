/**
 * Pure parser for the external plan spreadsheet's grid. No I/O: the grid is
 * handed in (sheet-source.ts fetches it), so every rule below is testable
 * with plain arrays.
 *
 * Why a cell carries TWO values (`formatted` and `value`) instead of one:
 * the sheet stores things that a single rendering gets wrong.
 *
 *  - IDs are NUMBERS in the sheet ("5.10" is the number 5.1 displayed with
 *    two decimals). Read unformatted, step 10 of area 5 becomes 5.1 and is
 *    indistinguishable from nothing at all — and "1.10" would collide with
 *    "1.1". The ID therefore comes from the cell's FORMATTED text.
 *  - Dates are serial numbers (days since 1899-12-30) whose formatted text
 *    depends on the spreadsheet's locale and number format ("25 Sep 2026",
 *    "25/09/2026", "2026-09-25"). Parsing that text would be a guess; the
 *    raw serial is unambiguous. Dates and progress come from the raw VALUE.
 *  - Progress is a 0-1 fraction (0.5 displays "50%"); the formatted text is
 *    locale-dependent, the fraction is not.
 *
 * Both renderings come from one spreadsheets.get snapshot (see
 * sheet-source.ts), so they can never describe two different versions of
 * the sheet.
 */

export interface RawCell {
  /** The cell as the sheet displays it (Sheets API `formattedValue`). null when the cell is empty. */
  formatted: string | null;
  /** The underlying value (Sheets API `effectiveValue`): a number for numbers/dates, else the string. null when empty. */
  value: string | number | boolean | null;
}

export type RawGrid = ReadonlyArray<ReadonlyArray<RawCell | null | undefined>>;

export interface PlanRow {
  /** "5.10" — the sheet's ID with its two-decimal step number intact. */
  id: string;
  area: string;
  step: string;
  /** The PIC exactly as written; resolution to a member is the sync's job. */
  pic: string | null;
  priority: string | null;
  /** ISO date YYYY-MM-DD. */
  start: string | null;
  /** ISO date YYYY-MM-DD, INCLUSIVE (see mapping.ts mustFinishBeforeFor). */
  deadline: string | null;
  /** The plan's own status text, trimmed ("Berjalan"); null when empty. */
  statusText: string | null;
  /** 0-1 fraction as the sheet stores it. */
  progress: number | null;
  dependsOn: string | null;
  output: string | null;
  doneWhen: string | null;
  risk: string | null;
  support: string | null;
  note: string | null;
}

export interface PlanParseResult {
  rows: PlanRow[];
  warnings: string[];
  /** 1-based sheet row number of the header. */
  headerRow: number;
}

/** The header cells that identify the plan table. All five must be on one row. */
const REQUIRED_HEADERS = ["id", "area perbaikan", "pic", "tahap pekerjaan", "deadline"] as const;

/** How far down to look for the header — a title block above it is normal. */
const HEADER_SEARCH_ROWS = 30;

type Field = keyof Omit<PlanRow, "id"> | "id";

/**
 * Accepted header texts per field, already normalized (see normalizeHeader).
 * The first five are the owner-specified headers; the rest are the plan's
 * optional columns, matched by a few plausible spellings so a harmless
 * rename in the sheet does not blind the sync to a column.
 */
const HEADER_ALIASES: Record<Field, readonly string[]> = {
  id: ["id"],
  area: ["area perbaikan"],
  pic: ["pic"],
  step: ["tahap pekerjaan"],
  deadline: ["deadline"],
  priority: ["prioritas", "priority"],
  start: ["mulai", "tanggal mulai", "tgl mulai", "start"],
  statusText: ["status"],
  progress: ["progress", "progres", "% progress", "progress (%)", "progress %"],
  dependsOn: ["dependensi", "dependency", "depends on"],
  output: ["output", "deliverable", "output / deliverable", "output/deliverable"],
  doneWhen: ["kriteria selesai", "selesai bila", "definition of done"],
  risk: ["risiko", "risk", "risiko / blocker", "risiko/blocker", "blocker"],
  support: ["support", "dukungan", "support dibutuhkan"],
  note: ["catatan", "keterangan", "note"],
};

/** Collapses whitespace and newlines ("Est. Durasi\n(hari)" -> "est. durasi (hari)") and lowercases. */
export function normalizeHeader(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Locates the column for each field. Exact alias match first (a header that
 * IS an alias always wins); then a tolerant second pass over the columns no
 * field has claimed: a header like "Output / Deliverable" or "Risiko /
 * Blocker" matches when any "/"-separated part is an alias, and a header
 * like "Support Dibutuhkan" matches when it STARTS with an alias as a whole
 * word. A column is never given to two fields, and an exact match elsewhere
 * is never displaced by a tolerant one.
 */
function locateColumns(header: readonly string[]): Record<Field, number> {
  const fields = Object.keys(HEADER_ALIASES) as Field[];
  const col = {} as Record<Field, number>;
  const claimed = new Set<number>();
  for (const field of fields) {
    col[field] = header.findIndex((h) => HEADER_ALIASES[field].includes(h));
    if (col[field] >= 0) claimed.add(col[field]);
  }
  for (const field of fields) {
    if (col[field] >= 0) continue;
    const aliases = HEADER_ALIASES[field];
    const idx = header.findIndex((h, i) => {
      if (claimed.has(i) || h === "") return false;
      const parts = h.split("/").map((p) => p.trim());
      if (parts.some((p) => aliases.includes(p))) return true;
      return aliases.some((a) => h.startsWith(`${a} `));
    });
    col[field] = idx;
    if (idx >= 0) claimed.add(idx);
  }
  return col;
}

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

const cellText = (cell: RawCell | null | undefined): string => (cell?.formatted ?? (typeof cell?.value === "string" ? cell.value : "")).trim();

/** "-" and its typographic cousins mean "nothing here" in the sheet, same as an empty cell. */
function isBlank(text: string): boolean {
  return text === "" || /^[-–—]+$/.test(text);
}

/** null for blank/dash cells, else the trimmed text. */
function textOrNull(cell: RawCell | null | undefined): string | null {
  const text = cellText(cell);
  return isBlank(text) ? null : text;
}

/**
 * The ID cell's text, with the sheet's two-decimal convention restored.
 *
 * Normally the formatted text is already "5.10". Two situations break that,
 * and both are repaired rather than trusted:
 *  - A General-format cell holding 5.1 displays "5.1". Since steps 1-9 are
 *    always written "5.01".."5.09", a single decimal digit can only be step
 *    10, so it is padded back to "5.10".
 *  - A spreadsheet locale with a decimal comma displays "5,10".
 * The caller is told via a warning whenever a repair happened, because a
 * repaired ID means the sheet's number format changed.
 */
function normalizeId(text: string): { id: string; repaired: boolean } {
  const trimmed = text.trim();
  const match = /^(\d+)[.,](\d{1,2})$/.exec(trimmed);
  if (!match) return { id: trimmed, repaired: false };
  const id = `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
  return { id, repaired: id !== trimmed };
}

/** Sheets serial day number (epoch 1899-12-30) to an ISO date. Fractions (time of day) are dropped. */
export function serialToIsoDate(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealIsoDate(text: string): boolean {
  const m = ISO_DATE.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** A date cell: a serial number, or (if the column is plain text) an ISO string. Anything else is null + a warning. */
function dateOrNull(cell: RawCell | null | undefined, label: string, at: string, warnings: string[]): string | null {
  if (!cell || cell.value === null || cell.value === undefined) return null;
  if (typeof cell.value === "number") {
    // 1 = 1899-12-31. Anything below ~1900 or past 2200 is not a plan date.
    if (cell.value < 1 || cell.value > 109_574) {
      warnings.push(`${at}: ${label} serial ${cell.value} is out of range, ignored`);
      return null;
    }
    return serialToIsoDate(cell.value);
  }
  const text = String(cell.value).trim();
  if (isBlank(text)) return null;
  if (isRealIsoDate(text)) return text;
  warnings.push(`${at}: ${label} "${text}" is not a date the parser can read unambiguously, ignored`);
  return null;
}

function progressOrNull(cell: RawCell | null | undefined, at: string, warnings: string[]): number | null {
  if (!cell || cell.value === null || cell.value === undefined) return null;
  if (typeof cell.value === "number") {
    if (cell.value >= 0 && cell.value <= 1) return cell.value;
    // Someone typed 50 into a cell that expects 0.5. Accept the unambiguous reading, but say so.
    if (cell.value > 1 && cell.value <= 100) {
      warnings.push(`${at}: progress ${cell.value} is above 1, read as ${cell.value}%`);
      return cell.value / 100;
    }
    warnings.push(`${at}: progress ${cell.value} is out of range, ignored`);
    return null;
  }
  const text = String(cell.value).trim();
  if (isBlank(text)) return null;
  warnings.push(`${at}: progress "${text}" is not a number, ignored`);
  return null;
}

function findHeaderRow(grid: RawGrid): number {
  const limit = Math.min(grid.length, HEADER_SEARCH_ROWS);
  for (let r = 0; r < limit; r++) {
    const cells = new Set((grid[r] ?? []).map((c) => normalizeHeader(cellText(c))));
    if (REQUIRED_HEADERS.every((h) => cells.has(h))) return r;
  }
  throw new PlanParseError(
    `plan header row not found in the first ${limit} rows (looked for ${REQUIRED_HEADERS.map((h) => `"${h}"`).join(", ")}) — refusing to read an unknown layout`,
  );
}

export function parsePlanGrid(grid: RawGrid): PlanParseResult {
  const warnings: string[] = [];
  const headerIndex = findHeaderRow(grid);
  const header = (grid[headerIndex] ?? []).map((c) => normalizeHeader(cellText(c)));

  // Columns by header name, never by position — the same rule (and the same
  // incident) as sheets/tasks-import.ts's locateColumns.
  const col = locateColumns(header);
  const missingOptional = (Object.keys(HEADER_ALIASES) as Field[]).filter(
    (f) => col[f] < 0 && !(["id", "area", "pic", "step", "deadline"] as Field[]).includes(f),
  );
  if (col.statusText < 0) {
    // Without Status the sync cannot tell done from not started; applying
    // "no status" to every task would be worse than not syncing.
    throw new PlanParseError(`plan sheet has no "Status" column — refusing to sync without it`);
  }
  for (const f of missingOptional) warnings.push(`column for "${HEADER_ALIASES[f][0]}" not found in the header, treated as empty`);

  const at = (cells: ReadonlyArray<RawCell | null | undefined>, field: Field): RawCell | null | undefined =>
    col[field] < 0 ? null : cells[col[field]];

  const rows: PlanRow[] = [];
  const seen = new Set<string>();
  let r = headerIndex + 1;
  for (; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const idText = cellText(at(cells, "id"));
    if (idText === "") break; // "until the ID cell is empty" — the table's end

    const where = `row ${r + 1}`;
    // The notes block under the table ("Catatan:", "1. ID = [No. Area]...") is
    // prose, not rows. If its text sits in the ID column, a non-ID-looking
    // cell with no Area and no Step ends the table — silently, it is not an error.
    if (!/^d+[.,]d{1,2}$/.test(idText) && !textOrNull(at(cells, "area")) && !textOrNull(at(cells, "step"))) break;
    const { id, repaired } = normalizeId(idText);
    if (repaired) warnings.push(`${where}: ID "${idText}" read as "${id}" (the sheet's two-decimal format was not applied)`);
    if (!/^\d+\.\d{2}$/.test(id)) warnings.push(`${where}: ID "${id}" does not look like <area>.<step>`);
    if (seen.has(id)) {
      warnings.push(`${where}: duplicate ID ${id}, skipped (first occurrence wins)`);
      continue;
    }

    const area = textOrNull(at(cells, "area"));
    const step = textOrNull(at(cells, "step"));
    if (!area || !step) {
      warnings.push(`${where}: ID ${id} has no ${!area ? "Area Perbaikan" : "Tahap Pekerjaan"}, skipped`);
      continue;
    }
    seen.add(id);

    rows.push({
      id,
      area,
      step,
      pic: textOrNull(at(cells, "pic")),
      priority: textOrNull(at(cells, "priority")),
      start: dateOrNull(at(cells, "start"), "Mulai", `${where} (${id})`, warnings),
      deadline: dateOrNull(at(cells, "deadline"), "Deadline", `${where} (${id})`, warnings),
      statusText: textOrNull(at(cells, "statusText")),
      progress: progressOrNull(at(cells, "progress"), `${where} (${id})`, warnings),
      dependsOn: textOrNull(at(cells, "dependsOn")),
      output: textOrNull(at(cells, "output")),
      doneWhen: textOrNull(at(cells, "doneWhen")),
      risk: textOrNull(at(cells, "risk")),
      support: textOrNull(at(cells, "support")),
      note: textOrNull(at(cells, "note")),
    });
  }

  // A gap in the ID column ends the table by the rule above. If real rows
  // follow the gap they are being ignored, and someone should hear about it.
  let afterGap = 0;
  for (let i = r + 1; i < grid.length; i++) {
    if (/^\d+[.,]\d+$/.test(cellText(at(grid[i] ?? [], "id")))) afterGap++;
  }
  if (afterGap > 0) warnings.push(`${afterGap} row(s) with an ID follow a blank ID row (row ${r + 1}) and were not read`);

  return { rows, warnings, headerRow: headerIndex + 1 };
}
