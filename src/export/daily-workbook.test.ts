import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { createTestDb } from "../db/testing.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { buildDailyWorkbook } from "./daily-workbook.ts";

const DAY = { year: 2026, month: 9, day: 8 };

async function seedOneReport(db: Awaited<ReturnType<typeof createTestDb>>) {
  const agas = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, agas.memberId, "active");
  const report = await getOrCreateDailyReport(db, agas.memberId, "2026-09-08");
  const revision = await addRevision(db, report.reportId, "report agas");
  await addReportItem(db, revision.revisionId, { activity: "Wiring docking", result: "selesai", status: "done" });
  return agas;
}

test("the workbook holds exactly one sheet, named for the day it covers", async () => {
  const db = await createTestDb();
  await seedOneReport(db);

  const { buffer, fileName } = await buildDailyWorkbook(db, DAY);
  const read = new ExcelJS.Workbook();
  await read.xlsx.load(buffer as unknown as ArrayBuffer);

  // The owner was explicit that a day's file contains that day and nothing
  // else: forwarding the whole spreadsheet would hand a third party every
  // day the division has ever worked, and every leave reason with it.
  assert.equal(read.worksheets.length, 1);
  assert.equal(read.worksheets[0]?.name, "2026-09-08 Sel");
  assert.match(fileName, /2026-09-08 Sel\.xlsx$/);
});

test("the sheet carries a header row and the day's actual rows", async () => {
  const db = await createTestDb();
  await seedOneReport(db);

  const { buffer, rowCount } = await buildDailyWorkbook(db, DAY);
  const read = new ExcelJS.Workbook();
  await read.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = read.worksheets[0]!;

  assert.equal(sheet.getRow(1).getCell(1).value, "Nama");
  assert.equal(sheet.getRow(2).getCell(1).value, "Agas");
  assert.equal(sheet.getRow(2).getCell(3).value, "Wiring docking");
  assert.equal(sheet.rowCount, rowCount + 1, "rowCount excludes the header");
});

// An empty file forwarded to the boss's assistant says the division did
// nothing that day. The executor refuses to send on this count.
test("a day nobody reported on yields a row count of zero", async () => {
  const db = await createTestDb();
  const { reportCount } = await buildDailyWorkbook(db, DAY);
  assert.equal(reportCount, 0, "nobody filed anything, whatever the grid looks like");
});
