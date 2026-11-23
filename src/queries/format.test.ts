import assert from "node:assert/strict";
import { test } from "node:test";
import type { Member } from "../members/types.ts";
import type { Project } from "../projects/types.ts";
import { computeMustFinishBefore } from "../tasks/deadline.ts";
import type { Task } from "../tasks/types.ts";
import { formatQueryResult } from "./format.ts";

// Pure rendering over fixed fixtures: no database, so these pin the exact
// text a member reads. 12:00 WIB on Saturday 2026-10-03.
const NOW = new Date("2026-10-03T05:00:00.000Z");

let seq = 0;
function task(overrides: Partial<Task> = {}): Task {
  seq++;
  return {
    taskId: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    title: `Task ${seq}`,
    normalizedTitle: `task ${seq}`,
    projectId: null,
    status: "active",
    deadlineLabel: null,
    mustFinishBefore: null,
    scheduledFor: null,
    latestUpdate: null,
    createdByMemberId: "00000000-0000-0000-0000-00000000aaaa",
    createdAt: NOW,
    updatedAt: NOW,
    staleSince: null,
    confirmationState: null,
    needsReassignment: false,
    sourceReference: null,
    version: 1,
    adminNote: null,
    ...overrides,
  };
}

/** A deadline that falls `days` from today: 0 = finish today, 1 = tomorrow, -2 = two days late. */
function due(days: number): Date {
  return computeMustFinishBefore({ year: 2026, month: 10, day: 3 + days + 1 });
}

const member = (preferredName: string) => ({ preferredName }) as Member;

test("member_tasks groups by status, attention first, with deadlines and warnings", () => {
  const text = formatQueryResult(
    {
      kind: "member_tasks",
      member: member("Gunawan"),
      scheduledFor: null,
      tasks: [
        task({ title: "Gimbal: kalibrasi sumbu pitch", sourceReference: "master-plan-aerolift:G4", status: "in_progress", mustFinishBefore: due(2) }),
        task({ title: "Wiring strobo", status: "blocked", mustFinishBefore: due(5) }),
        task({ title: "Cek panel B", status: "in_progress", mustFinishBefore: due(-2) }),
        task({ title: "Rakit frame", status: "done", mustFinishBefore: due(-9) }),
        task({ title: "Beli baut", status: "active" }),
      ],
    },
    NOW,
  );
  assert.equal(
    text,
    [
      "📋 *Task Gunawan* — 4 terbuka",
      "",
      "*Terhambat (1)*",
      "• ⚠️ Wiring strobo — H-5",
      "",
      "*Berjalan (2)*",
      "• [G4] kalibrasi sumbu pitch — H-2",
      "• ⚠️ Cek panel B — terlambat 2 hari",
      "",
      "*Belum mulai (1)*",
      "• Beli baut",
      "",
      "*Selesai (1)*",
      "• ✅ Rakit frame",
    ].join("\n"),
  );
});

test("member_tasks for a given day says it was that day, and an empty day is not 'no tasks at all'", () => {
  const scoped = formatQueryResult({ kind: "member_tasks", member: member("Nisa"), scheduledFor: "2026-10-05", tasks: [task({ title: "Centering docking" })] }, NOW);
  assert.match(scoped, /^📋 \*Task Nisa\* — untuk Sen, 5 Okt · 1 terbuka\n/);

  assert.equal(
    formatQueryResult({ kind: "member_tasks", member: member("Nisa"), scheduledFor: "2026-10-05", tasks: [] }, NOW),
    "📋 *Task Nisa* — tidak ada task untuk Sen, 5 Okt",
  );
  assert.equal(
    formatQueryResult({ kind: "member_tasks", member: member("Nisa"), scheduledFor: null, tasks: [] }, NOW),
    "📋 *Task Nisa* — tidak ada task yang sedang dikerjakan",
  );
});

test("member_tasks caps a long group so the message stays short", () => {
  const tasks = Array.from({ length: 40 }, (_, i) => task({ title: `Pekerjaan nomor ${i}`, status: "active" }));
  const text = formatQueryResult({ kind: "member_tasks", member: member("Budi"), scheduledFor: null, tasks }, NOW);
  assert.match(text, /• \+34 lainnya/);
  assert.ok(text.length < 3500);
});

test("project_summary leads with a counts line, then the tasks", () => {
  const text = formatQueryResult(
    {
      kind: "project_summary",
      project: { name: "Drone VEGA" } as Project,
      tasks: [
        task({ title: "Tune PID", status: "in_progress" }),
        task({ title: "Uji terbang", status: "in_progress" }),
        task({ title: "Pasang ESC", status: "blocked" }),
        task({ title: "Cetak mount", status: "done" }),
      ],
    },
    NOW,
  );
  assert.equal(
    text,
    [
      "📁 *Project Drone VEGA* — 4 task",
      "",
      "1 terhambat · 2 berjalan · 1 selesai",
      "",
      "• Tune PID — Berjalan",
      "• Uji terbang — Berjalan",
      "• ⚠️ Pasang ESC — Terhambat",
      "• ✅ Cetak mount — Selesai",
    ].join("\n"),
  );
  assert.equal(formatQueryResult({ kind: "project_summary", project: { name: "Kosong" } as Project, tasks: [] }, NOW), "📁 *Project Kosong* — belum ada task tercatat");
});

test("nearest_deadline is grouped by bucket and names the date, never ISO", () => {
  const text = formatQueryResult(
    {
      kind: "nearest_deadline",
      overdue: [task({ title: "Solder PCB", mustFinishBefore: due(-3) })],
      dueToday: [task({ title: "Uji gimbal", mustFinishBefore: due(0) })],
      h1: [task({ title: "Kalibrasi", mustFinishBefore: due(1) })],
      h3: [task({ title: "Laporan akhir", mustFinishBefore: due(3) })],
    },
    NOW,
  );
  assert.equal(
    text,
    [
      "⏰ *Deadline terdekat* — 4 task",
      "",
      "*Terlambat (1)*",
      "• ⚠️ Solder PCB — terlambat 3 hari",
      "",
      "*Hari ini (1)*",
      "• Uji gimbal — Sab, 3 Okt",
      "",
      "*Besok (H-1) (1)*",
      "• Kalibrasi — Min, 4 Okt",
      "",
      "*H-3 (1)*",
      "• Laporan akhir — Sel, 6 Okt",
    ].join("\n"),
  );
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
  assert.equal(
    formatQueryResult({ kind: "nearest_deadline", overdue: [], dueToday: [], h1: [], h3: [] }, NOW),
    "⏰ *Deadline terdekat* — tidak ada dalam waktu dekat",
  );
});

test("missing_reporters is a count plus names, or a plain all-clear", () => {
  assert.equal(
    formatQueryResult({ kind: "missing_reporters", members: [member("Budi"), member("Siti")] }, NOW),
    "⏰ *Belum lapor hari ini* — 2 orang\n\n• Budi\n• Siti",
  );
  assert.equal(formatQueryResult({ kind: "missing_reporters", members: [] }, NOW), "✅ *Semua sudah lapor hari ini*");
});

test("a disambiguation question lists the candidates and asks which one", () => {
  assert.equal(
    formatQueryResult({ kind: "member_not_found", searchText: "Bud", candidates: [member("Budi Santoso"), member("Budi Prakoso")] }, NOW),
    '🔍 *Ada beberapa member mirip "Bud"*\n\n• Budi Santoso\n• Budi Prakoso\n\nMaksudnya yang mana?',
  );
  assert.equal(formatQueryResult({ kind: "project_not_found", searchText: "Zzz", candidates: [] }, NOW), '🔍 *Project tidak ditemukan* — "Zzz"');
});

test("task_status shows the Indonesian status, the deadline, and the latest update", () => {
  assert.equal(
    formatQueryResult({ kind: "task_status", task: task({ title: "Cek panel B", status: "blocked", mustFinishBefore: due(1), latestUpdate: "Menunggu relay" }) }, NOW),
    "📌 *Cek panel B*\nStatus: Terhambat · besok\nUpdate terakhir: Menunggu relay",
  );
});

test("task_created echoes the title in full, the day, and the people", () => {
  const text = formatQueryResult(
    {
      kind: "task_created",
      task: task({ title: "Centering docking di lokasi B" }),
      assignees: [member("Nisa"), member("Udin")],
      scheduledFor: "2026-10-05",
    },
    NOW,
  );
  assert.equal(text, '✅ *Task dibuat*\n\n"Centering docking di lokasi B"\nHari kerja: Sen, 5 Okt\nPenanggung jawab: Nisa dan Udin');
});

test("overtime replies name the day as a label and keep the report instruction", () => {
  assert.equal(
    formatQueryResult({ kind: "overtime_today", day: "2026-10-03", reporters: [{ preferredName: "Fikri", startText: "17:00", endText: "21:00" }] }, NOW),
    "🕐 *Lembur Sab, 3 Okt* — 1 orang\n\n• Fikri (17:00–21:00)",
  );
  assert.equal(
    formatQueryResult({ kind: "overtime_checked_in", day: "2026-10-03", alreadyReported: false, startText: "17:00" }, NOW),
    '🕐 *Lembur Sab, 3 Okt tercatat* — mulai 17:00\nNanti kirim laporan lemburnya, awali dengan "Report lembur".',
  );
});

test("denials share one shape", () => {
  assert.equal(formatQueryResult({ kind: "task_create_denied" }, NOW), "🚫 *Ditolak*\nHanya admin yang bisa membuat dan menugaskan task lewat chat.");
});

test("availability lists every day as a label with the reason underneath", () => {
  const text = formatQueryResult(
    { kind: "availability_set", member: member("Andre"), availabilityKind: "izin", days: ["2026-10-05", "2026-10-06"], reason: "bimbingan skripsi" },
    NOW,
  );
  assert.equal(text, "📆 *Tercatat* — Andre izin\n\n• Sen, 5 Okt\n• Sel, 6 Okt\n\nAlasan: bimbingan skripsi");
});
