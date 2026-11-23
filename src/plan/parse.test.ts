import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeHeader, parsePlanGrid, PlanParseError, serialToIsoDate, type RawCell, type RawGrid } from "./parse.ts";

const txt = (s: string | null): RawCell | null => (s === null ? null : { formatted: s, value: s });
const num = (n: number, formatted: string): RawCell => ({ formatted, value: n });

const HEADER = [
  "ID",
  "Area Perbaikan",
  "PIC",
  "Tahap Pekerjaan",
  "Prioritas",
  "Mulai",
  "Deadline",
  "Est. Durasi\n(hari)",
  "Dependensi",
  "Output",
  "Kriteria Selesai",
  "Risiko",
  "Support",
  "Status",
  "Progress",
  "Catatan",
].map(txt);

interface RowInput {
  id: RawCell | null;
  area?: string;
  pic?: string | null;
  step?: string | null;
  start?: RawCell | null;
  deadline?: RawCell | null;
  status?: string | null;
  progress?: RawCell | null;
  dependsOn?: string | null;
  note?: string | null;
}

function dataRow(r: RowInput): (RawCell | null)[] {
  return [
    r.id,
    txt(r.area ?? "BMS Drone Kestrel"),
    txt(r.pic === undefined ? "Bagas" : r.pic),
    txt(r.step === undefined ? "Soldering PCB" : r.step),
    txt("P2"),
    r.start === undefined ? num(46293, "28 Sep 2026") : r.start,
    r.deadline === undefined ? num(46293, "28 Sep 2026") : r.deadline,
    num(1, "1"),
    txt(r.dependsOn === undefined ? "-" : r.dependsOn),
    txt("PCB terpasang"),
    txt("Lolos tes"),
    txt("-"),
    txt("-"),
    txt(r.status === undefined ? "Berjalan" : r.status),
    r.progress === undefined ? num(0.5, "50%") : r.progress,
    txt(r.note === undefined ? null : r.note),
  ];
}

const idCell = (n: number, formatted: string): RawCell => num(n, formatted);

test("normalizeHeader collapses whitespace and newlines", () => {
  assert.equal(normalizeHeader("Est. Durasi\n(hari)"), "est. durasi (hari)");
  assert.equal(normalizeHeader("  Area   Perbaikan "), "area perbaikan");
});

test("the header row is found by its text, below a title block, with a newline inside a header", () => {
  const grid: RawGrid = [[txt("To Do List Perbaikan Aerolift Drone Mobil")], [], HEADER, dataRow({ id: idCell(1.01, "1.01") })];
  const result = parsePlanGrid(grid);
  assert.equal(result.headerRow, 3);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.id, "1.01");
  assert.equal(result.rows[0]?.area, "BMS Drone Kestrel");
  assert.equal(result.rows[0]?.step, "Soldering PCB");
});

test("columns are located by header name, not position", () => {
  // Same data, columns shuffled: Status and Deadline moved to the front.
  const order = [13, 6, 0, 1, 2, 3, 5, 14];
  const pick = (cells: (RawCell | null)[]) => order.map((i) => cells[i] ?? null);
  const grid: RawGrid = [pick(HEADER), pick(dataRow({ id: idCell(2.05, "2.05"), status: "Selesai" }))];
  const row = parsePlanGrid(grid).rows[0];
  assert.equal(row?.id, "2.05");
  assert.equal(row?.statusText, "Selesai");
  assert.equal(row?.deadline, "2026-09-28");
  assert.equal(row?.start, "2026-09-28");
  assert.equal(row?.progress, 0.5);
});

test("an ID stored as a number keeps its two-decimal text: 5.10 stays 5.10", () => {
  const grid: RawGrid = [
    HEADER,
    dataRow({ id: idCell(5.01, "5.01") }),
    dataRow({ id: idCell(5.1, "5.10") }),
    dataRow({ id: idCell(1.1, "1.10") }),
    dataRow({ id: idCell(1.01, "1.01") }),
  ];
  assert.deepEqual(
    parsePlanGrid(grid).rows.map((r) => r.id),
    ["5.01", "5.10", "1.10", "1.01"],
  );
});

test("an ID displayed without its trailing zero (General format) or with a decimal comma is repaired, with a warning", () => {
  const grid: RawGrid = [HEADER, dataRow({ id: idCell(5.1, "5.1") }), dataRow({ id: idCell(3.07, "3,07") })];
  const result = parsePlanGrid(grid);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ["5.10", "3.07"],
  );
  assert.equal(result.warnings.filter((w) => w.includes("two-decimal")).length, 2);
});

test("dates are read from serial numbers (epoch 1899-12-30), not from locale-formatted text", () => {
  assert.equal(serialToIsoDate(46290), "2026-09-25");
  assert.equal(serialToIsoDate(46300.75), "2026-10-05");
  assert.equal(serialToIsoDate(1), "1899-12-31");
  const grid: RawGrid = [HEADER, dataRow({ id: idCell(1.01, "1.01"), start: num(46290, "25/09/2026"), deadline: num(46300, "Oct 5, 2026") })];
  const row = parsePlanGrid(grid).rows[0];
  assert.equal(row?.start, "2026-09-25");
  assert.equal(row?.deadline, "2026-10-05");
});

test("a date typed as ISO text is accepted; any other text is ignored with a warning", () => {
  const grid: RawGrid = [HEADER, dataRow({ id: idCell(1.01, "1.01"), start: txt("2026-09-25"), deadline: txt("minggu depan") })];
  const result = parsePlanGrid(grid);
  assert.equal(result.rows[0]?.start, "2026-09-25");
  assert.equal(result.rows[0]?.deadline, null);
  assert.ok(result.warnings.some((w) => w.includes("minggu depan")));
});

test("progress is a 0-1 fraction; a bare 50 is read as 50% with a warning; junk is null", () => {
  const rows = (progress: RawCell | null) => parsePlanGrid([HEADER, dataRow({ id: idCell(1.01, "1.01"), progress })]);
  assert.equal(rows(num(0.75, "75%")).rows[0]?.progress, 0.75);
  assert.equal(rows(num(0, "0%")).rows[0]?.progress, 0);
  assert.equal(rows(num(1, "100%")).rows[0]?.progress, 1);
  const percentTyped = rows(num(50, "50"));
  assert.equal(percentTyped.rows[0]?.progress, 0.5);
  assert.equal(percentTyped.warnings.length, 1);
  assert.equal(rows(txt("-")).rows[0]?.progress, null);
  assert.equal(rows(null).rows[0]?.progress, null);
  assert.equal(rows(num(250, "250")).rows[0]?.progress, null);
});

test("dash and empty cells are null, in text and date columns alike", () => {
  const grid: RawGrid = [
    HEADER,
    dataRow({ id: idCell(1.01, "1.01"), pic: "-", start: txt("-"), deadline: null, status: "–", dependsOn: "-", note: null }),
  ];
  const row = parsePlanGrid(grid).rows[0];
  assert.equal(row?.pic, null);
  assert.equal(row?.start, null);
  assert.equal(row?.deadline, null);
  assert.equal(row?.statusText, null);
  assert.equal(row?.dependsOn, null);
  assert.equal(row?.note, null);
  assert.equal(row?.output, "PCB terpasang");
});

test("reading stops at the first empty ID; trailing blank rows are not rows", () => {
  const grid: RawGrid = [
    HEADER,
    dataRow({ id: idCell(1.01, "1.01") }),
    dataRow({ id: idCell(1.02, "1.02") }),
    [],
    [txt(""), txt(""), txt("")],
    [],
  ];
  const result = parsePlanGrid(grid);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.warnings, []);
});

test("rows that follow a blank ID row are not read, and the parser says so", () => {
  const grid: RawGrid = [HEADER, dataRow({ id: idCell(1.01, "1.01") }), [], dataRow({ id: idCell(1.02, "1.02") })];
  const result = parsePlanGrid(grid);
  assert.equal(result.rows.length, 1);
  assert.ok(result.warnings.some((w) => w.includes("follow a blank ID row")));
});

test("duplicate IDs and rows without a step are skipped with a warning", () => {
  const grid: RawGrid = [
    HEADER,
    dataRow({ id: idCell(1.01, "1.01") }),
    dataRow({ id: idCell(1.01, "1.01"), step: "Salinan" }),
    dataRow({ id: idCell(1.02, "1.02"), step: null }),
  ];
  const result = parsePlanGrid(grid);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ["1.01"],
  );
  assert.equal(result.warnings.length, 2);
});

test("a missing required header throws instead of guessing a layout", () => {
  const noPic = HEADER.filter((h) => h?.formatted !== "PIC");
  assert.throws(() => parsePlanGrid([noPic, dataRow({ id: idCell(1.01, "1.01") })]), PlanParseError);
  assert.throws(() => parsePlanGrid([]), PlanParseError);
});

test("without a Status column the parse refuses; other optional columns missing only warn", () => {
  const noStatus = HEADER.filter((h) => h?.formatted !== "Status");
  assert.throws(() => parsePlanGrid([noStatus]), /Status/);
  const noRisk = HEADER.filter((h) => h?.formatted !== "Risiko");
  const result = parsePlanGrid([noRisk]);
  assert.equal(result.rows.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("risiko")));
});

// The header row exactly as the supervisor's real "Master Plan" sheet has it.
const REAL_HEADER = [
  "ID",
  "Area Perbaikan",
  "PIC",
  "Tahap Pekerjaan",
  "Prioritas",
  "Mulai",
  "Deadline",
  "Est. Durasi\n(hari)",
  "Dependensi",
  "Output / Deliverable",
  "Kriteria Selesai",
  "Risiko / Blocker",
  "Support Dibutuhkan",
  "Status",
  "Progress",
  "Sisa Hari",
  "Catatan",
].map(txt);

function realRow(id: string, idNum: number, step: string): (RawCell | null)[] {
  return [
    num(idNum, id),
    txt("Wiring dan PSU"),
    txt("Bagas"),
    txt(step),
    txt("P1"),
    num(46293, "28 Sep 2026"),
    num(46296, "01 Okt 2026"),
    num(3, "3"),
    txt("5.02"),
    txt("Box PSU terpasang"),
    txt("Lolos tes"),
    txt("Part belum datang"),
    txt("Bantuan teknisi"),
    txt("Berjalan"),
    num(0.5, "50%"),
    num(2, "2"),
    txt("catatan baris"),
  ];
}

test("the real sheet's header row: Output / Deliverable, Risiko / Blocker and Support Dibutuhkan are all found", () => {
  const result = parsePlanGrid([REAL_HEADER, realRow("5.03", 5.03, "Wiring box PSU mobil aerolift drone 2")]);
  const row = result.rows[0];
  assert.equal(row?.output, "Box PSU terpasang");
  assert.equal(row?.risk, "Part belum datang");
  assert.equal(row?.support, "Bantuan teknisi");
  assert.equal(row?.doneWhen, "Lolos tes");
  assert.equal(row?.dependsOn, "5.02");
  assert.equal(row?.statusText, "Berjalan");
  assert.equal(row?.progress, 0.5);
  assert.equal(row?.note, "catatan baris");
  // Nothing about the real header may be reported as missing.
  assert.deepEqual(result.warnings, []);
});

test("the Catatan: block below the data is neither rows nor errors, wherever its text sits", () => {
  const notes = [
    "1. ID = [No. Area].[No. Urut Tahap]",
    "2. Status: Belum Mulai / Berjalan / Selesai / Blocked",
    "3. Sisa Hari dihitung otomatis dari Deadline",
  ];
  const blank = Array.from({ length: 17 }, () => null);
  // (a) label and notes in column B, ID column empty.
  const inB = (text: string) => [null, txt(text), ...blank.slice(2)];
  const gridB: RawGrid = [
    REAL_HEADER,
    realRow("5.03", 5.03, "Wiring box PSU mobil aerolift drone 2"),
    realRow("5.04", 5.04, "QC dan pemasangan kedua box"),
    [],
    inB("Catatan:"),
    ...notes.map(inB),
  ];
  const a = parsePlanGrid(gridB);
  assert.deepEqual(a.rows.map((r) => r.id), ["5.03", "5.04"]);
  assert.deepEqual(a.warnings, []);

  // (b) the same block with its text in the ID column, directly under the table (no blank row).
  const inA = (text: string) => [txt(text), ...blank.slice(1)];
  const gridA: RawGrid = [REAL_HEADER, realRow("5.03", 5.03, "Wiring box PSU mobil aerolift drone 2"), inA("Catatan:"), ...notes.map(inA)];
  const b = parsePlanGrid(gridA);
  assert.deepEqual(b.rows.map((r) => r.id), ["5.03"]);
  assert.deepEqual(b.warnings, []);
});
