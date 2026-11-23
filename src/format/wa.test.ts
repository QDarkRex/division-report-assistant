import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMustFinishBefore } from "../tasks/deadline.ts";
import {
  bold,
  bulletList,
  clampMessage,
  countsLine,
  dayLabel,
  joinBlocks,
  obstacleCategoryLabel,
  relativeDeadline,
  section,
  statusLabel,
  taskLabel,
  titleLine,
} from "./wa.ts";

// 12:00 WIB on Saturday 2026-10-03.
const NOW = new Date("2026-10-03T05:00:00.000Z");

test("bold wraps in WhatsApp asterisks", () => {
  assert.equal(bold("Task"), "*Task*");
});

test("bulletList prefixes a bullet and collapses the overflow into one line", () => {
  assert.deepEqual(bulletList(["a", "b"]), ["• a", "• b"]);
  assert.deepEqual(bulletList(["a", "b", "c", "d"], { max: 2 }), ["• a", "• b", "• +2 lainnya"]);
  assert.equal(bulletList(Array.from({ length: 8 }, (_, i) => String(i))).length, 8, "exactly max is not an overflow");
  assert.equal(bulletList(Array.from({ length: 9 }, (_, i) => String(i))).at(-1), "• +1 lainnya");
  assert.deepEqual(bulletList([]), []);
});

test("section puts a bold label above its lines", () => {
  assert.equal(section("Berjalan (2)", ["• a", "• b"]), "*Berjalan (2)*\n• a\n• b");
});

test("joinBlocks separates blocks with one blank line and drops empty ones", () => {
  assert.equal(joinBlocks("a", "", "b\nc", null, undefined, false), "a\n\nb\nc");
  assert.equal(joinBlocks(), "");
});

test("titleLine is emoji, bold title, and an optional context after a dash", () => {
  assert.equal(titleLine("📋", "Task Gunawan", "17 terbuka"), "📋 *Task Gunawan* — 17 terbuka");
  assert.equal(titleLine("📋", "Task Gunawan"), "📋 *Task Gunawan*");
});

test("countsLine joins on a middle dot and omits zeros unless everything is zero", () => {
  assert.equal(countsLine([[12, "berjalan"], [0, "ditunda"], [3, "terhambat"], [2, "terlambat"]]), "12 berjalan · 3 terhambat · 2 terlambat");
  assert.equal(countsLine([[0, "aktivitas"], [0, "update task"]]), "0 aktivitas");
});

test("clampMessage leaves short text alone and cuts long text at a line boundary", () => {
  assert.equal(clampMessage("pendek"), "pendek");
  const long = Array.from({ length: 400 }, (_, i) => `baris nomor ${i}`).join("\n");
  const clamped = clampMessage(long, 200);
  assert.ok(clamped.length <= 200);
  assert.ok(clamped.endsWith("\n…"));
});

test("dayLabel is Indonesian short form in Jakarta terms, from a CalendarDay or an ISO string", () => {
  assert.equal(dayLabel({ year: 2026, month: 10, day: 3 }), "Sab, 3 Okt");
  assert.equal(dayLabel("2026-10-03"), "Sab, 3 Okt");
  assert.equal(dayLabel("2026-08-09"), "Min, 9 Agu");
  assert.equal(dayLabel("2026-05-04"), "Sen, 4 Mei");
  assert.equal(dayLabel("2026-12-31"), "Kam, 31 Des");
});

test("dayLabel does not guess at text that is not a date", () => {
  assert.equal(dayLabel("besok"), "besok");
});

test("relativeDeadline counts from the last day the task can still be finished", () => {
  const due = (labelDay: number) => computeMustFinishBefore({ year: 2026, month: 10, day: labelDay });
  assert.equal(relativeDeadline(due(4), NOW), "hari ini", "label day 4 means finish by the 3rd");
  assert.equal(relativeDeadline(due(5), NOW), "besok");
  assert.equal(relativeDeadline(due(6), NOW), "H-2");
  assert.equal(relativeDeadline(due(10), NOW), "H-6");
  assert.equal(relativeDeadline(due(3), NOW), "terlambat 1 hari");
  assert.equal(relativeDeadline(due(1), NOW), "terlambat 3 hari");
});

test("statusLabel covers every task status in Indonesian", () => {
  const expected: Record<string, string> = {
    active: "Belum mulai",
    active_unreviewed: "Perlu ditinjau",
    in_progress: "Berjalan",
    blocked: "Terhambat",
    paused: "Ditunda",
    stale: "Macet",
    status_conflict: "Konflik status",
    done: "Selesai",
    cancelled: "Dibatalkan",
  };
  for (const [status, label] of Object.entries(expected)) assert.equal(statusLabel(status), label);
  assert.equal(statusLabel("something_new"), "something_new", "an unknown status is shown, not hidden");
});

test("obstacleCategoryLabel translates the classifier's categories", () => {
  assert.equal(obstacleCategoryLabel("waiting_material"), "menunggu material");
  assert.equal(obstacleCategoryLabel("unseen"), "unseen");
});

test("taskLabel shows [id] step for master-plan tasks and the plain title otherwise", () => {
  assert.equal(
    taskLabel({ title: "Gimbal: kalibrasi sumbu pitch", sourceReference: "master-plan-aerolift:G4" }),
    "[G4] kalibrasi sumbu pitch",
  );
  assert.equal(taskLabel({ title: "Cek panel B", sourceReference: null }), "Cek panel B");
  assert.equal(taskLabel({ title: "Cek panel B: lantai 2", sourceReference: "sheets-import:12" }), "Cek panel B: lantai 2");
  assert.equal(taskLabel({ title: "Tanpa area", sourceReference: "master-plan-aerolift:T9" }), "[T9] Tanpa area");
  assert.equal(taskLabel({ title: "Area: langkah", sourceReference: "master-plan-aerolift" }), "Area: langkah", "no id, nothing to bracket");
});

test("taskLabel truncates to 70 characters with an ellipsis", () => {
  const label = taskLabel({ title: "x".repeat(200) });
  assert.equal(label.length, 70);
  assert.ok(label.endsWith("…"));
  assert.equal(taskLabel({ title: "y".repeat(70) }), "y".repeat(70), "exactly 70 is untouched");
});
