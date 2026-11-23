import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOvertimeIntent, clockLabel, type OvertimePreIntent } from "./overtime-intent.ts";

const IN = (timeText?: string): OvertimePreIntent => ({ intent: "overtime_checkin", ...(timeText ? { timeText } : {}) });
const OUT = (timeText?: string): OvertimePreIntent => ({ intent: "overtime_checkout", ...(timeText ? { timeText } : {}) });
const LIST: OvertimePreIntent = { intent: "overtime_today" };

const CASES: Array<[string, OvertimePreIntent | null]> = [
  // Real phrasings seen in production (2026-10-03 / 2026-10-08) -> check-in
  ["lembur", IN()],
  ["Lembur", IN()],
  ["absen lembur", IN()],
  ["Absen lembur", IN()],
  ["mengajukan lembur", IN()],
  ["Mengajukan lembur", IN()],
  ["ngejukan lembur", IN()],
  ["izin pengajuan lembur", IN()],
  // Other declarations
  ["ngajukan lembur", IN()],
  ["ajukan lembur", IN()],
  ["pengajuan lembur", IN()],
  ["daftar lembur", IN()],
  ["saya lembur", IN()],
  ["aku lembur ya", IN()],
  ["ikut lembur", IN()],
  ["mulai lembur", IN()],
  ["lembur.", IN()],
  ["lembur!", IN()],
  ["  lembur   dong ", IN()],
  ["lembur malam ini", IN()],
  // Bot mentions are removed
  ["@helper lembur", IN()],
  ["@628123456789 absen lembur", IN()],
  // With a time (kept as written)
  ["lembur jam 5", IN("jam 5")],
  ["mulai lembur jam 17.00", IN("jam 17.00")],
  ["lembur jam 17:30", IN("jam 17:30")],
  ["lembur pukul 18", IN("pukul 18")],
  ["absen lembur 17.00", IN("17.00")],
  ["lembur jam 5 sore", IN("jam 5 sore")],
  // Checkout
  ["selesai lembur", OUT()],
  ["lembur selesai", OUT()],
  ["saya selesai lembur", OUT()],
  ["udah selesai lembur", OUT()],
  ["pulang lembur jam 9", OUT("jam 9")],
  ["stop lembur jam 21.00", OUT("jam 21.00")],
  ["udahan lembur", OUT()],
  ["lembur beres", OUT()],
  ["lembur kelar pukul 22", OUT("pukul 22")],
  // Questions / lists -> overtime_today, never a mutation
  ["siapa yang lembur", LIST],
  ["siapa yang lembur?", LIST],
  ["siapa aja yg lembur hari ini?", LIST],
  ["lihat daftar lembur", LIST],
  ["daftar yang lembur", LIST],
  ["rekap lembur", LIST],
  ["lembur?", LIST],
  ["lembur siapa", LIST],
  ["daftar lembur hari ini siapa saja", LIST],
  ["hari ini siapa lembur", LIST],
  ["cek lembur", LIST],
  ["list lembur", LIST],
  ["berapa orang yang lembur", LIST],
  ["siapa yang udah selesai lembur?", LIST],
  ["@helper siapa yang lembur hari ini?", LIST],
  // Falls through to the LLM
  ["Nisa lembur", null],
  ["Nisa lembur?", null],
  ["lembur besok", null],
  ["besok saya lembur", null],
  ["lembur kemarin jam 5", null],
  ["lembur tanggal 12", null],
  ["tolong catat Nisa dan Udin lembur", null],
  ["udah lembur", null],
  ["lembur aja", null],
  ["ada lembur", null],
  ["selesai lembur mulai lembur", null],
  ["lembur @628111", null],
  ["saya lembur sampai malam karena ada deadline panel besok pagi", null],
  ["kerja bagus", null],
  ["tugas Nisa besok apa", null],
  ["", null],
];

test("overtime pre-classifier: table of real and likely phrasings", () => {
  for (const [text, expected] of CASES) {
    assert.deepEqual(classifyOvertimeIntent(text), expected, JSON.stringify(text));
  }
});

test("a question never yields a mutating intent, whatever else it contains", () => {
  for (const text of ["siapa yang lembur jam 5?", "lembur jam 5 siapa", "selesai lembur siapa?"]) {
    assert.equal(classifyOvertimeIntent(text)?.intent, "overtime_today", text);
  }
});

test("clockLabel does not double the word jam", () => {
  assert.equal(clockLabel("jam 5"), "jam 5");
  assert.equal(clockLabel("pukul 18"), "pukul 18");
  assert.equal(clockLabel("17.00"), "jam 17.00");
});
