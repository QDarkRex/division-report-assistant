import assert from "node:assert/strict";
import { test } from "node:test";
import { hasReportHeader, isOvertimeReport, looksLikeReportAttempt } from "./header.ts";
import { normalizeIncomingText } from "../messages/normalize.ts";

// 2026-10-03: every line began with U+200E (WhatsApp adds it when text is copied
// from an earlier message), so "‎Report Lembur Setiawan" never matched.
const LRM_REPORT = [
  "‎Report Lembur Setiawan",
  "‎tanggal 3 Oktober 2026",
  "‎",
  "‎- troubleshooting PCB SMD",
  "‎- solder ulang konektor",
].join("\n");

test("without normalization the LRM-prefixed report is invisible (the production bug)", () => {
  assert.equal(hasReportHeader(LRM_REPORT), false);
});

test("after normalization the LRM-prefixed report is a report header and an overtime report", () => {
  const text = normalizeIncomingText(LRM_REPORT);
  assert.equal(hasReportHeader(text), true);
  assert.equal(isOvertimeReport(text), true);
});

const LONG_PARAGRAPH =
  "report hari ini saya melakukan troubleshooting dan menemukan bahwa penggunaan pcb smd pada rangkaian charger menyebabkan arus bocor, " +
  "lalu saya ganti komponen dan test ulang beberapa kali sampai hasilnya stabil, besok lanjut merapikan kabel dan pengujian akhir";

test("looksLikeReportAttempt: the real single-paragraph example (headerless, long) triggers", () => {
  assert.ok(LONG_PARAGRAPH.length >= 150);
  assert.equal(hasReportHeader(LONG_PARAGRAPH), false);
  assert.equal(looksLikeReportAttempt(LONG_PARAGRAPH), true);
});

test("looksLikeReportAttempt: three short lines opening with a report word trigger, emphasis marks ignored", () => {
  assert.equal(looksLikeReportAttempt("*Laporan* hari ini\n- solder\n- test"), true);
  assert.equal(looksLikeReportAttempt("_lapor_ bang\nkerja a\nkerja b"), true);
});

test("looksLikeReportAttempt: casual chat, questions and queries do not trigger", () => {
  assert.equal(looksLikeReportAttempt("udah report belum?"), false);
  assert.equal(looksLikeReportAttempt("@helper siapa yang belum lapor"), false);
  assert.equal(looksLikeReportAttempt("report dong"), false);
  assert.equal(looksLikeReportAttempt("report hari ini siapa aja yang belum kirim ya"), false);
  assert.equal(looksLikeReportAttempt("lapor"), false);
  assert.equal(looksLikeReportAttempt(""), false);
  assert.equal(looksLikeReportAttempt("pekerjaan hari ini\n- solder\n- test\n- rapikan"), false, "first line must be a report word");
  assert.equal(looksLikeReportAttempt("reportase kegiatan kemarin sangat bagus sekali dan menarik untuk dibaca ulang oleh semua anggota divisi supaya paham alurnya, termasuk yang baru bergabung minggu ini kemarin"), false);
});

test("looksLikeReportAttempt: a long question is chat, not a report", () => {
  const question = `${"report hari ini yang kemarin itu sebenarnya harus dikirim ke siapa dan jam berapa ".repeat(2)}ya?`;
  assert.ok(question.length >= 150);
  assert.equal(looksLikeReportAttempt(question), false);
});
