import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { members } from "../db/schema.ts";
import { createMember, setMembershipStatus, setMemberLevel as setMemberLevelForTest } from "../members/service.ts";
import { setAvailability as setAvailabilityForTest } from "../members/availability.ts";
import { addReportItem, addRevision, getOrCreateDailyReport, markNoActivity, setOvertimeTimes } from "../reports/service.ts";
import { confirmProject, createProject } from "../projects/service.ts";
import { createTask } from "../tasks/service.ts";
import { assertNotReservedTabName, buildDateTabRows, DATE_TAB_HEADER, dateTabName } from "./date-tabs.ts";
import { setAvailability } from "../members/availability.ts";

test("dateTabName formats as YYYY-MM-DD Ddd with the correct Jakarta weekday", () => {
  // 2026-08-08 is a Saturday.
  assert.equal(dateTabName({ year: 2026, month: 8, day: 8 }), "2026-08-08 Sab");
  // 2026-08-09 is a Sunday.
  assert.equal(dateTabName({ year: 2026, month: 8, day: 9 }), "2026-08-09 Min");
  // 2026-08-10 is a Monday.
  assert.equal(dateTabName({ year: 2026, month: 8, day: 10 }), "2026-08-10 Sen");
});

test("assertNotReservedTabName throws for a name colliding with a fixed tab", () => {
  assert.throws(() => assertNotReservedTabName("MEMBERS"));
  assert.doesNotThrow(() => assertNotReservedTabName("2026-08-08 Sab"));
});

test("a member with no report at all gets a 'belum lapor' row", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 8 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.[0], "Budi");
  assert.equal(rows[0]?.[2], "— belum lapor —");
});

test("a member not required to report is excluded entirely", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi", reportRequired: false });
  await setMembershipStatus(db, member.memberId, "active");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 8 });
  assert.equal(rows.length, 0);
});

test("a no-activity report gets one row with the placeholder text", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-08");
  await markNoActivity(db, report.reportId);

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 8 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.[2], "— tidak ada aktivitas —");
});

test("a member with multiple activities gets one row per item, and a merge block spanning them", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-08");
  const revision = await addRevision(db, report.reportId, "report\n- a\n- b");
  await addReportItem(db, revision.revisionId, { activity: "cek panel A", status: "in_progress" });
  await addReportItem(db, revision.revisionId, { activity: "cek panel B", status: "done" });

  const { rows, nameMergeBlocks } = await buildDateTabRows(db, { year: 2026, month: 8, day: 8 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.[2], "cek panel A");
  assert.equal(rows[1]?.[2], "cek panel B");
  assert.deepEqual(nameMergeBlocks, [[0, 1]]);
});

test("a single-row member produces no merge block", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-08");
  const revision = await addRevision(db, report.reportId, "report\n- a");
  await addReportItem(db, revision.revisionId, { activity: "cek panel A", status: "in_progress" });

  const { nameMergeBlocks } = await buildDateTabRows(db, { year: 2026, month: 8, day: 8 });
  assert.deepEqual(nameMergeBlocks, []);
});

test("only report items for the requested day are included, not other days", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const reportToday = await getOrCreateDailyReport(db, member.memberId, "2026-08-08");
  const revToday = await addRevision(db, reportToday.reportId, "report\n- x");
  await addReportItem(db, revToday.revisionId, { activity: "kerjaan hari ini", status: "done" });

  const reportYesterday = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const revYesterday = await addRevision(db, reportYesterday.reportId, "report\n- y");
  await addReportItem(db, revYesterday.revisionId, { activity: "kerjaan kemarin", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 8 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.[2], "kerjaan hari ini");
});

test("Proyek column resolves via the matched task's project", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const project = await createProject(db, { name: "Drone VEGA" });
  await confirmProject(db, project.projectId);
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: member.memberId, projectId: project.projectId });

  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-08");
  const revision = await addRevision(db, report.reportId, "report\n- cek panel B");
  await addReportItem(db, revision.revisionId, { activity: "cek panel B", status: "in_progress", taskId: task.taskId });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 8 });
  assert.equal(rows[0]?.[1], "Drone VEGA");
});

// Owner request 2026-08-12: a declared absence must read as "cuti"/"izin"/
// "sakit" in the Aktivitas column, not the "belum lapor" placeholder that
// made a legitimate absence look like ignoring the bot.
test("a member on leave shows the leave kind in the Aktivitas column instead of 'belum lapor'", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day: 12 });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 12 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.[2], "cuti");
});

test("each leave kind renders as its own plain word", async () => {
  for (const [kind, expected] of [
    ["izin", "izin"],
    ["sakit", "sakit"],
    ["not_scheduled", "tidak dijadwalkan"],
  ] as const) {
    const db = await createTestDb();
    const member = await createMember(db, { preferredName: "Budi" });
    await setMembershipStatus(db, member.memberId, "active");
    await setAvailability(db, member.memberId, kind, { year: 2026, month: 8, day: 12 });

    const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 12 });
    assert.equal(rows[0]?.[2], expected, `${kind} should render as "${expected}"`);
  }
});

// §14 explicitly allows a member on leave to still submit a report — if
// they did, their actual work is the more useful thing to show.
test("a member on leave who still reported shows their report, not the leave label", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await setAvailability(db, member.memberId, "izin", { year: 2026, month: 8, day: 12 });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-12");
  const revision = await addRevision(db, report.reportId, "report\n- tetap cek panel");
  await addReportItem(db, revision.revisionId, { activity: "tetap cek panel", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 12 });
  assert.equal(rows[0]?.[2], "tetap cek panel");
});

test("leave on a different day does not leak into this day's tab", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day: 11 });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 12 });
  assert.equal(rows[0]?.[2], "— belum lapor —");
});

// Owner 2026-08-29: outside magang, Saturday attendance is not required,
// so a quiet Saturday must not read as the reproachful "belum lapor".
test("on Saturday a non-magang with no report reads 'tidak masuk', not 'belum lapor'", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 29 });
  assert.equal(rows[0]?.[2], "tidak masuk");
});

test("on Saturday a magang with no report still reads 'belum lapor'", async () => {
  const db = await createTestDb();
  const magang = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, magang.memberId, "active");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 29 });
  assert.equal(rows[0]?.[2], "— belum lapor —");
});

// "...sampai mereka mengirim report atau secara eksplisit bilang masuk"
test("a non-magang who reported on Saturday shows their work, not 'tidak masuk'", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));

  const report = await getOrCreateDailyReport(db, senior.memberId, "2026-08-29");
  const revision = await addRevision(db, report.reportId, "report\n- lembur wiring");
  await addReportItem(db, revision.revisionId, { activity: "lembur wiring", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 29 });
  assert.equal(rows[0]?.[2], "lembur wiring");
});

test("a non-magang who declared 'masuk' on Saturday is back to 'belum lapor' until they report", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));
  await setAvailability(db, senior.memberId, "masuk", { year: 2026, month: 8, day: 29 });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 29 });
  assert.equal(rows[0]?.[2], "— belum lapor —");
});

test("on a weekday a non-magang with no report still reads 'belum lapor'", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 28 });
  assert.equal(rows[0]?.[2], "— belum lapor —");
});

// Owner's own examples, 2026-08-29.
test("a leave reason appears next to the kind in the Aktivitas column", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await setAvailability(db, member.memberId, "izin", { year: 2026, month: 8, day: 28 }, "bimbingan skripsi");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 28 });
  assert.equal(rows[0]?.[2], "izin — bimbingan skripsi");
});

test("sakit with a reason reads naturally too", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await setAvailability(db, member.memberId, "sakit", { year: 2026, month: 8, day: 28 }, "diare");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 28 });
  assert.equal(rows[0]?.[2], "sakit — diare");
});

// The reason is optional, so the no-reason path must stay exactly as it was.
test("without a reason the cell is just the kind, with no trailing dash", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day: 28 });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 8, day: 28 });
  assert.equal(rows[0]?.[2], "cuti");
});

// ---------------------------------------------------------------------
// 2026-09-06: marking Yudha resigned erased all 18 days of his work from
// the spreadsheet, because a date tab was built from currently-active
// members alone. Hafiz and four others had already gone the same way.
// The reports were never lost — they were in the database throughout —
// but the sheet is what the admins read, so from where they sit the work
// had simply never happened.
// ---------------------------------------------------------------------

test("a departed member's report still appears on the day they filed it", async () => {
  const db = await createTestDb();
  const yudha = await createMember(db, { preferredName: "Yudha" });
  await setMembershipStatus(db, yudha.memberId, "active");
  const report = await getOrCreateDailyReport(db, yudha.memberId, "2026-09-04");
  const revision = await addRevision(db, report.reportId, "report yudha");
  await addReportItem(db, revision.revisionId, { activity: "Mengganti ip kamera vega", status: "done" });

  await setMembershipStatus(db, yudha.memberId, "resigned");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 4 });
  const yudhaRows = rows.filter((r) => r[0] === "Yudha");
  assert.equal(yudhaRows.length, 1, "the day he actually worked must survive his departure");
  assert.equal(yudhaRows[0]?.[2], "Mengganti ip kamera vega");
});

// The other half of the rule: someone who has left owes nothing, so a day
// they did not report is simply not their row. Back-filling "belum lapor"
// across every tab since would invent an absence nobody claimed.
test("a departed member gets no row on a day they filed nothing", async () => {
  const db = await createTestDb();
  const yudha = await createMember(db, { preferredName: "Yudha" });
  await setMembershipStatus(db, yudha.memberId, "active");
  const report = await getOrCreateDailyReport(db, yudha.memberId, "2026-09-04");
  await addRevision(db, report.reportId, "report yudha");
  await setMembershipStatus(db, yudha.memberId, "resigned");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 5 });
  assert.equal(rows.filter((r) => r[0] === "Yudha").length, 0);
});

test("an active member who filed nothing still gets a belum-lapor row", async () => {
  const db = await createTestDb();
  const agas = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, agas.memberId, "active");

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 4 });
  const agasRows = rows.filter((r) => r[0] === "Agas");
  assert.equal(agasRows.length, 1);
  assert.match(agasRows[0]?.[2] ?? "", /belum lapor/);
});

// ---------------------------------------------------------------------
// Overtime column (2026-09-11). The date tab gained a trailing "Lembur"
// cell: "ya" for a row that belongs to an overtime report, empty for a
// regular one. A member can appear with both.
// ---------------------------------------------------------------------

const LEMBUR_COL = DATE_TAB_HEADER.indexOf("Lembur");

test("the Lembur and Keterangan columns exist", () => {
  assert.ok(DATE_TAB_HEADER.includes("Lembur"));
  assert.equal(DATE_TAB_HEADER[DATE_TAB_HEADER.length - 1], "Keterangan");
});

test("overtime work is marked in the Lembur column; regular work is not", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");

  const reg = await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "regular");
  const regRev = await addRevision(db, reg.reportId, "report agas");
  await addReportItem(db, regRev.revisionId, { activity: "wiring docking", status: "in_progress" });

  const ot = await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "overtime");
  const otRev = await addRevision(db, ot.reportId, "report lembur agas");
  await addReportItem(db, otRev.revisionId, { activity: "lanjut solder malam", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 8 });
  const regRow = rows.find((r) => r[2] === "wiring docking");
  const otRow = rows.find((r) => r[2] === "lanjut solder malam");
  assert.equal(regRow?.[LEMBUR_COL], "", "regular work is not marked");
  assert.equal(otRow?.[LEMBUR_COL], "ya", "overtime work is marked");
});

// A check-in ("absen lembur") with no work yet is an item-less overtime
// report. It must be visible and naggable, not hidden — the same discipline
// as the regular "belum lapor" row.
test("an overtime check-in with no work reads 'lembur — belum lapor'", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");

  await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "overtime"); // check-in, no revision/items

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 8 });
  const otRow = rows.find((r) => r[0] === "Agas" && r[LEMBUR_COL] === "ya");
  assert.ok(otRow, "the check-in must appear");
  assert.match(otRow?.[2] ?? "", /lembur — belum lapor/);
});

// Every existing row now has the extra trailing cell, so nothing downstream
// that assumes a fixed column count silently misaligns.
test("every row has exactly as many cells as the header", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");
  const reg = await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "regular");
  const rev = await addRevision(db, reg.reportId, "report agas");
  await addReportItem(db, rev.revisionId, { activity: "wiring", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 8 });
  for (const row of rows) assert.equal(row.length, DATE_TAB_HEADER.length);
});

const KETERANGAN_COL = DATE_TAB_HEADER.indexOf("Keterangan");

test("telat shows in the Keterangan column on the member's first row, work still visible", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");
  await setAvailabilityForTest(db, m.memberId, "telat", { year: 2026, month: 9, day: 8 }, "datang jam 10");
  const reg = await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "regular");
  const rev = await addRevision(db, reg.reportId, "report agas");
  await addReportItem(db, rev.revisionId, { activity: "wiring docking", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 8 });
  const agasRows = rows.filter((r) => r[0] === "Agas");
  assert.equal(agasRows[0]?.[2], "wiring docking", "the work is still there, not replaced");
  assert.match(agasRows[0]?.[KETERANGAN_COL] ?? "", /telat — datang jam 10/);
});

test("overtime start/stop render as a range in the Lembur column", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");
  const ot = await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "overtime");
  await setOvertimeTimes(db, ot.reportId, { startText: "17:00", endText: "21:00" });
  const rev = await addRevision(db, ot.reportId, "report lembur");
  await addReportItem(db, rev.revisionId, { activity: "solder malam", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 8 });
  const otRow = rows.find((r) => r[2] === "solder malam");
  const lemburCol = DATE_TAB_HEADER.indexOf("Lembur");
  assert.equal(otRow?.[lemburCol], "17:00–21:00");
});

test("an overtime report with no times still marks the Lembur column", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");
  const ot = await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "overtime");
  const rev = await addRevision(db, ot.reportId, "report lembur");
  await addReportItem(db, rev.revisionId, { activity: "solder malam", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 8 });
  const otRow = rows.find((r) => r[2] === "solder malam");
  assert.equal(otRow?.[DATE_TAB_HEADER.indexOf("Lembur")], "ya");
});

// 2026-09-12: a staff member doing Saturday overtime showed "tidak masuk"
// in their regular row above their lembur work — flatly contradictory. A
// member who filed overtime came in; the not-expected placeholder is
// dropped for them, and only the overtime rows remain.
test("a not-expected member with overtime shows no 'tidak masuk', only the lembur rows", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Fadlan" });
  await setMembershipStatus(db, m.memberId, "active");
  await setMemberLevelForTest(db, m.memberId, "staff");
  // 2026-09-12 is a Saturday: staff+ are not expected to file a regular report.
  const ot = await getOrCreateDailyReport(db, m.memberId, "2026-09-12", "overtime");
  const rev = await addRevision(db, ot.reportId, "report lembur fadlan");
  await addReportItem(db, rev.revisionId, { activity: "troubleshoot bms", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 12 });
  const mine = rows.filter((r) => r[0] === "Fadlan" || (rows.indexOf(r) > 0 && r[0] === ""));
  const fadlanBlock = [];
  let inBlock = false;
  for (const r of rows) {
    if (r[0] === "Fadlan") { inBlock = true; fadlanBlock.push(r); continue; }
    if (inBlock && r[0] === "") { fadlanBlock.push(r); continue; }
    if (inBlock && r[0] !== "") break;
  }
  const texts = fadlanBlock.map((r) => r[2]);
  assert.ok(!texts.includes("tidak masuk"), "no tidak masuk row for a member who did overtime");
  assert.ok(texts.includes("troubleshoot bms"), "the overtime work shows");
  assert.equal(fadlanBlock[0]?.[DATE_TAB_HEADER.indexOf("Lembur")], "ya");
});

// The other side of the rule: a weekday member still owes their regular
// report, so overtime does NOT hide "belum lapor".
test("an expected member who only did overtime still reads belum lapor for the regular report", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active"); // magang, expected on a weekday
  // 2026-09-08 is a Tuesday.
  const ot = await getOrCreateDailyReport(db, m.memberId, "2026-09-08", "overtime");
  const rev = await addRevision(db, ot.reportId, "report lembur agas");
  await addReportItem(db, rev.revisionId, { activity: "solder malam", status: "done" });

  const { rows } = await buildDateTabRows(db, { year: 2026, month: 9, day: 8 });
  const texts = rows.filter((r) => r[0] === "Agas" || r[0] === "").map((r) => r[2]);
  assert.ok(texts.some((t) => /belum lapor/.test(t ?? "")), "still owes the regular report");
});
