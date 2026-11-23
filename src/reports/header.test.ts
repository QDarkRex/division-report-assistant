import assert from "node:assert/strict";
import { test } from "node:test";
import { hasReportHeader, isOvertimeReport, stripEmphasis } from "./header.ts";

// ACCEPTANCE_TESTS.md §2.2
test("report with header \"report\" is processed", () => {
  assert.equal(hasReportHeader("report\n- pekerjaan: test docking charge"), true);
});

test("report with header \"report Agas\" is processed", () => {
  assert.equal(hasReportHeader("report Agas\n- pekerjaan: cek panel"), true);
});

test("\"daily report\" header is processed", () => {
  assert.equal(hasReportHeader("daily report\n- selesai instalasi"), true);
});

test("bullet list without a header does not count as a valid report", () => {
  assert.equal(hasReportHeader("- pekerjaan: test docking charge\n- hasil: berhasil"), false);
});

test("casual conversation is not a report", () => {
  assert.equal(hasReportHeader("halo semua, ada info penting"), false);
});

test("report header with a trailing colon is still accepted", () => {
  assert.equal(hasReportHeader("report Agas:\n- pekerjaan: cek panel"), true);
});

test("laporan harian header (Indonesian, alone) is accepted", () => {
  assert.equal(hasReportHeader("laporan harian\n- cek trafo"), true);
});

// A reminder that merely starts with the trigger word must NOT be treated as a report —
// this was the original false-positive: a plain prefix check would have matched these.
test("an admin reminder that happens to start with the trigger word is rejected", () => {
  assert.equal(hasReportHeader("Report harian jangan lupa ya semua"), false);
  assert.equal(hasReportHeader("Laporan hari ini paling lambat jam 9 ya"), false);
  assert.equal(hasReportHeader("report dong yang belum, ditunggu ya"), false);
});

test("a reminder naming someone by name (not a header) is still rejected", () => {
  assert.equal(hasReportHeader("Agas, jangan lupa report ya"), false);
});

// Found live 2026-08-07: a real report from the owner was silently dropped
// because its header line (name + full date) exceeded the ≤3-word cap.
test("a header with a name and full date (weekday + month + year) is accepted", () => {
  assert.equal(
    hasReportHeader("Report Affan Jumat 7 Agustus 2026\n- Melanjutkan routing PCB Strobo"),
    true,
  );
});

test("a header with just a weekday name is accepted", () => {
  assert.equal(hasReportHeader("Report Agas Senin"), true);
});

test("a bare small number in a longer non-header sentence is not mistaken for a date signal", () => {
  assert.equal(hasReportHeader("Laporan hari ini paling lambat jam 9 ya"), false);
});

test("a long trailing sentence with no date token is still rejected even under the loosened cap", () => {
  assert.equal(hasReportHeader("report kerjakan semua tugas kalian sekarang juga ya teman teman"), false);
});

// ---------------------------------------------------------------------
// 2026-09-05, from the live group: Gunawan sent his report five times in
// nine minutes before one was accepted, with "ko ga ngarti bro @helper"
// in between. Each rejected form is a test below. The four rejected ones
// went to ephemeral context storage with no reply explaining why, so
// from his side the bot had simply ignored him.
// ---------------------------------------------------------------------

test("a header wrapped in WhatsApp bold is still a header", () => {
  assert.equal(hasReportHeader("*Report Gunawan*\nJumat, 4 september\nIssue:"), true);
});

test("a header wrapped in pasted markdown bold is still a header", () => {
  assert.equal(hasReportHeader("**Report Gunawam**\nJumat, 4 september\nIssue:"), true);
  assert.equal(hasReportHeader("**Laporan Harian: Perakitan Antarmuka Audio**\nTujuan Proyek"), true);
});

test("a header carrying its subject after a colon is still a header", () => {
  assert.equal(hasReportHeader("report gunawan : Perakitan Antarmuka Audio LattePanda & Samsung A06\nTujuan Proyek"), true);
});

// The reason the length cap exists in the first place. Emphasis stripping
// and colon splitting must not reopen it.
test("reminders are still not reports, decorated or not", () => {
  assert.equal(hasReportHeader("Report harian jangan lupa ya semua"), false);
  assert.equal(hasReportHeader("*Report harian jangan lupa ya semua*"), false);
  assert.equal(hasReportHeader("Laporan hari ini paling lambat jam 9 ya"), false);
  assert.equal(hasReportHeader("**Laporan hari ini paling lambat jam 9 ya**"), false);
});

// A colon does not make any sentence a header — what precedes it still
// has to look like one.
test("a colon does not turn a sentence into a header", () => {
  assert.equal(hasReportHeader("Laporan yang belum masuk sampai sekarang: Agas, Budi, Andre"), false);
});

test("emphasis stripping removes decoration and nothing else", () => {
  // Regression guard with teeth: an earlier version of this pattern lost
  // the backslash from its s class and matched a literal "s", quietly
  // trimming real letters off both ends of every line it touched.
  assert.equal(stripEmphasis("**Report Gunawam**"), "Report Gunawam");
  assert.equal(stripEmphasis("*Report Gunawan*"), "Report Gunawan");
  assert.equal(stripEmphasis("  Laporan Agas Kamis  "), "Laporan Agas Kamis");
  assert.equal(stripEmphasis("sabtu solder status"), "sabtu solder status", "leading and trailing s are letters, not decoration");
});

// ---------------------------------------------------------------------
// Overtime (lembur) headers, added 2026-09-11. Overtime routing is
// decided from the header text alone, never by the model, so this
// detection has to be exact: it changes which report a member's work
// lands in.
// ---------------------------------------------------------------------

test("an overtime report is recognised as both a report and an overtime one", () => {
  for (const header of ["Report lembur", "Report lembur Agas", "Lembur Agas", "Report overtime", "*Lembur Agas*"]) {
    assert.equal(hasReportHeader(header + "\n- kerja"), true, `${header} should be a report`);
    assert.equal(isOvertimeReport(header + "\n- kerja"), true, `${header} should be overtime`);
  }
});

test("an ordinary report is not overtime", () => {
  assert.equal(isOvertimeReport("Report Agas\n- wiring docking"), false);
  assert.equal(isOvertimeReport("Report Agas 5 September 2026\n- wiring"), false);
});

// The word appearing in the BODY is not an overtime report — only the
// header decides.
test("a normal report whose body mentions lembur is still a regular report", () => {
  const text = "Report Agas\n- bantu lembur bang Budi solder PCB";
  assert.equal(hasReportHeader(text), true);
  assert.equal(isOvertimeReport(text), false);
});

// The length cap still guards: an ordinary sentence starting with the new
// keyword is not a header.
test("lembur as a keyword does not swallow ordinary sentences", () => {
  assert.equal(hasReportHeader("lembur banget hari ini capek semua"), false);
  assert.equal(isOvertimeReport("lembur banget hari ini capek semua"), false);
});

// ---------------------------------------------------------------------
// 2026-09-22: Gunawan's three report attempts all got no reply. The header
// "Report Pengerjaan — Selasa, 22 September 2026" failed because the old
// whole-line word-token match could not cross the em dash and comma, so a
// real report was silently dropped. A line that starts with the keyword and
// names a date is now a header whatever punctuation sits between.
// ---------------------------------------------------------------------

test("a header with an em dash and comma before the date is still a header", () => {
  assert.equal(hasReportHeader("Report Pengerjaan — Selasa, 22 September 2026\n- solder pcb"), true);
  assert.equal(hasReportHeader("report Pengerjaan — Selasa, 22 September 2026\nProyek: BMS"), true);
});

test("a long-but-dated header line is accepted", () => {
  assert.equal(hasReportHeader("Report Kristanto  LAPORAN HARIAN   Tanggal:  21 September 2026\n- kerja"), true);
});

// The date signal is still the guard: a reminder cites no date and stays out,
// even though it starts with the keyword and runs long.
test("a dateless reminder is still rejected however it is punctuated", () => {
  assert.equal(hasReportHeader("Report harian jangan lupa ya semua — kirim sekarang!"), false);
  assert.equal(hasReportHeader("Laporan hari ini paling lambat jam 9 ya"), false);
});

// A whole paragraph that merely mentions a month must not be swept up as a header.
test("a long paragraph mentioning a month is not a header", () => {
  assert.equal(
    hasReportHeader("Report harian mulai bulan September ini wajib dikirim setiap hari sebelum jam sembilan malam ya rekan semua tanpa terkecuali"),
    false,
  );
});
