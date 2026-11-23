import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import {
  buildColumnRequests,
  columnIndex,
  DAILY_REPORTS_FORMAT,
  MEMBERS_FORMAT,
  REPORT_ITEMS_FORMAT,
} from "./formatting.ts";

test("columnIndex resolves by header text, not position", () => {
  assert.equal(columnIndex(["Nama", "Peran", "Status"], "Status"), 2);
  assert.equal(columnIndex(["Nama", "Peran", "Status"], "Peran"), 1);
});

test("columnIndex throws on a header the spec references but the sheet doesn't have", () => {
  assert.throws(() => columnIndex(["Nama"], "Peran"));
});

test("every column in every format spec matches the real exported header row", async () => {
  const { buildMembersRows, buildDailyReportsRows, buildReportItemsRows } = await import("./export.ts");
  const db = await createTestDb();

  const membersHeader = (await buildMembersRows(db))[0] ?? [];
  const dailyReportsHeader = (await buildDailyReportsRows(db))[0] ?? [];
  const reportItemsHeader = (await buildReportItemsRows(db))[0] ?? [];

  for (const col of MEMBERS_FORMAT.columns) {
    assert.doesNotThrow(() => columnIndex(membersHeader, col.header), `MEMBERS format references unknown header "${col.header}"`);
  }
  for (const col of DAILY_REPORTS_FORMAT.columns) {
    assert.doesNotThrow(() => columnIndex(dailyReportsHeader, col.header), `DAILY_REPORTS format references unknown header "${col.header}"`);
  }
  for (const col of REPORT_ITEMS_FORMAT.columns) {
    assert.doesNotThrow(() => columnIndex(reportItemsHeader, col.header), `REPORT_ITEMS format references unknown header "${col.header}"`);
  }
});

test("Revisi Terakhir gets NUMBER formatting, not DATE_TIME (correcting the design draft's slip)", () => {
  const col = DAILY_REPORTS_FORMAT.columns.find((c) => c.header === "Revisi Terakhir");
  assert.equal(col?.numberFormat?.type, "NUMBER");
});

test("buildColumnRequests produces one conditional-format request per TEXT_EQ rule, targeting the resolved column", () => {
  const headerRow = ["Tanggal Lapor", "Nama", "Status Item"];
  const requests = buildColumnRequests(42, REPORT_ITEMS_FORMAT.columns.filter((c) => c.header === "Status Item"), headerRow);

  const cfRequests = requests.filter((r) => r.addConditionalFormatRule);
  assert.equal(cfRequests.length, 6, "one rule per Status Item enum value");
  for (const req of cfRequests) {
    const range = req.addConditionalFormatRule?.rule?.ranges?.[0];
    assert.equal(range?.sheetId, 42);
    assert.equal(range?.startColumnIndex, 2, "Status Item resolved to index 2 in this header row");
    assert.equal(range?.endColumnIndex, 3);
  }
});

test("buildColumnRequests sets a wide pixel width and WRAP for free-text columns", () => {
  const headerRow = ["Tanggal Lapor", "Nama", "Judul Task", "Aktivitas", "Hasil", "Ada Kendala", "Status Item", "Dibuat"];
  const requests = buildColumnRequests(1, REPORT_ITEMS_FORMAT.columns.filter((c) => c.header === "Aktivitas"), headerRow);

  const widthRequest = requests.find((r) => r.updateDimensionProperties);
  assert.equal(widthRequest?.updateDimensionProperties?.properties?.pixelSize, 340);

  const formatRequest = requests.find((r) => r.repeatCell);
  assert.equal(formatRequest?.repeatCell?.cell?.userEnteredFormat?.wrapStrategy, "WRAP");
});
