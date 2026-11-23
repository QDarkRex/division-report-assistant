import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorningBriefFacts, type BriefOverdueItem, type BriefPlanChangeGroup, type MorningBriefFacts } from "./facts.ts";
import { sanitizeBriefOutput } from "./llm.ts";
import { flagLine, planChangeLine, renderMorningBrief } from "./render.ts";
import { BRIEF_NOW, seedBriefWorld } from "./testing.ts";

async function fixtureFacts() {
  const { db } = await seedBriefWorld();
  return buildMorningBriefFacts(db, BRIEF_NOW);
}

function llmFor(facts: MorningBriefFacts) {
  return sanitizeBriefOutput(
    {
      ringkasan: "Dua langkah BMS terlambat dan konektor XT90 masih menahan pengadaan. Fokus hari ini ke winch tether.",
      prioritas: [
        { planRef: "3.07", alasan: "jatuh tempo hari ini, motor winch belum datang" },
        { planRef: "1.01", alasan: "terlambat paling lama, selesaikan soldering dulu" },
      ],
      hambatan: [
        { planRef: "6.02", masalah: "konektor XT90 belum dikirim supplier", saran: "Bagas minta ETA tertulis hari ini; bila tidak ada, eskalasi ke tim Mechanical", pic: "Bagas" },
      ],
    },
    facts,
  );
}

test("renders every section from the facts when the model answered", async () => {
  const facts = await fixtureFacts();
  const text = renderMorningBrief(facts, llmFor(facts));

  assert.equal(
    text,
    [
      "☀️ *Rangkuman Pagi* — Sab, 3 Okt",
      "",
      "*Aerolift Drone Mobil* — progress 38%",
      "2 selesai · 4 berjalan · 2 belum mulai · 1 terhambat",
      "Dua langkah BMS terlambat dan konektor XT90 masih menahan pengadaan. Fokus hari ini ke winch tether.",
      "",
      "*Prioritas hari ini*",
      "• [3.07] Integrasi winch tether — jatuh tempo hari ini, motor winch belum datang",
      "• [1.01] Soldering PCB BMS 4S — terlambat paling lama, selesaikan soldering dulu",
      "",
      "*Hambatan & saran*",
      "• ⚠️ [6.02] konektor XT90 belum dikirim supplier → Bagas minta ETA tertulis hari ini; bila tidak ada, eskalasi ke tim Mechanical",
      "",
      "*Terlambat (2)*",
      "• ⚠️ [1.01] Soldering PCB BMS 4S — Bagas · terlambat 5 hari",
      "• ⚠️ [1.02] Uji charging pack — Gunawan · terlambat 2 hari",
      "",
      "*Jatuh tempo hari ini (1)*",
      "• [3.07] Integrasi winch tether — Bagas",
      "",
      "*Jatuh tempo besok (1)*",
      "• [3.08] Kalibrasi sensor tegangan — Gunawan",
      "",
      "*Mulai hari ini (1)*",
      "• [4.04] Dokumentasi uji — Wisnu",
      "",
      "*Perubahan plan sejak kemarin*",
      "• [3.08] deadline Sab, 3 Okt → Min, 4 Okt",
      "• [5.02] Berjalan → Selesai · progress 50% → 100%",
      "",
      "*Perlu dicek*",
      '• Bagas lapor selesai [1.01], plan masih Berjalan — "soldering PCB BMS"',
      '• Laporan Bagas "soldering PCB BMS" — mungkin [3.07], menunggu jawaban',
      "",
      "*Belum ada laporan (2)*",
      "• [3.07] Bagas · [4.03] Gunawan",
      "",
      "*Lainnya*",
      "• Task lain: 1 aktif",
      "• Izin/cuti/sakit hari ini: Udin",
    ].join("\n"),
  );
  console.log(`\n--- sample (${text.length} chars) ---\n${text}\n---`);
});

test("without the model: no priorities, raw blockers without advice, everything else unchanged", async () => {
  const facts = await fixtureFacts();
  const withLlm = renderMorningBrief(facts, llmFor(facts));
  const without = renderMorningBrief(facts, null);

  assert.doesNotMatch(without, /Prioritas hari ini/);
  assert.doesNotMatch(without, /→ Bagas minta/);
  assert.doesNotMatch(without, /Fokus hari ini ke winch/);
  assert.match(without, /\*Hambatan & saran\*\n• ⚠️ \[6\.02\] Konektor belum datang, supplier belum konfirmasi, hubungi \[nomor\] \(Bagas, menunggu komponen\)\n• /);
  for (const kept of ["*Terlambat (2)*", "*Perubahan plan sejak kemarin*", "*Perlu dicek*", "*Belum ada laporan (2)*", "*Lainnya*", "progress 38%"]) {
    assert.ok(without.includes(kept), `${kept} should survive without the model`);
  }
  assert.ok(without.length < withLlm.length);
});

test("an empty model answer falls back to raw blockers rather than an empty section", async () => {
  const facts = await fixtureFacts();
  const text = renderMorningBrief(facts, { ringkasan: "", prioritas: [], hambatan: [] });
  assert.match(text, /\*Hambatan & saran\*\n• ⚠️ \[6\.02\]/);
});

test("sections with nothing in them are left out", async () => {
  const facts = await fixtureFacts();
  const quietDay: MorningBriefFacts = {
    ...facts,
    plan: null,
    planChanges: [],
    flags: [],
    quiet: [],
    blockers: { reportingDay: null, fromReports: [], planBlocked: [], riskDueSoon: [] },
    general: { active: 0, overdue: 0, dueToday: 0, blocked: 0, completedYesterday: 0, onLeaveToday: [] },
  };
  assert.equal(renderMorningBrief(quietDay, null), "☀️ *Rangkuman Pagi* — Sab, 3 Okt");
});

test("a Monday brief names the day its changes reach back to", async () => {
  const facts = await fixtureFacts();
  const monday = { ...facts, today: "2026-10-05", since: new Date("2026-10-03T01:00:00.000Z").toISOString() };
  assert.match(renderMorningBrief(monday, null), /\*Perubahan plan sejak Sab, 3 Okt\*/);
});

test("flag lines use a sentence per known kind and still show an unknown one", () => {
  const base = { member: "Bagas", planRef: "aerolift:1.06", planStatus: "Berjalan", activity: null, note: null };
  assert.equal(flagLine({ ...base, kind: "done_vs_plan" }), "Bagas lapor selesai [1.06], plan masih Berjalan");
  assert.equal(flagLine({ ...base, kind: "blocked_vs_plan", planStatus: "Berjalan" }), "Bagas lapor terhambat [1.06], plan menunjukkan Berjalan");
  assert.equal(flagLine({ ...base, kind: "other_pic" }), "Bagas melapor [1.06] yang PIC-nya orang lain");
  assert.equal(flagLine({ ...base, kind: "early_start" }), "Bagas sudah mengerjakan [1.06] sebelum jadwal mulai");
  assert.equal(flagLine({ ...base, kind: "dependency_open" }), "Bagas mengerjakan [1.06] padahal dependensinya belum selesai");
  assert.equal(flagLine({ ...base, planRef: null, kind: "no_urgent_work" }), "Bagas belum melaporkan task urgent-nya");
  assert.equal(
    flagLine({ ...base, planRef: null, kind: "no_urgent_work", planIds: ["3.07", "3.08"] }),
    "Bagas belum melaporkan task urgent-nya ([3.07] [3.08])",
  );
  // The producer may store the full ref or the bare id; both print the same.
  assert.equal(flagLine({ ...base, planRef: "3.07", kind: "done_vs_plan" }), flagLine({ ...base, planRef: "aerolift:3.07", kind: "done_vs_plan" }));
  // The producer's note duplicates the sentence and is not printed; the activity is quoted, short.
  assert.equal(flagLine({ ...base, planRef: null, kind: "low_confidence", note: "tulisan ambigu" }), "Laporan Bagas — kurang jelas, menunggu jawaban");
  const longActivity = "Perakitan BMS pack baterai sambungan seri paralel dari cell 1 sampai cell 8 hari ini";
  assert.equal(
    flagLine({ ...base, kind: "done_vs_plan", activity: longActivity, note: "Dilaporkan selesai oleh Bagas, tapi status di plan masih Berjalan." }),
    'Bagas lapor selesai [1.06], plan masih Berjalan — "Perakitan BMS pack baterai sambungan seri paralel…"',
  );
  assert.equal(
    flagLine({ ...base, kind: "low_confidence", planRef: "aerolift:2.08", activity: "Troubleshooting pembacaan suhu" }),
    'Laporan Bagas "Troubleshooting pembacaan suhu" — mungkin [2.08], menunggu jawaban',
  );
  assert.equal(flagLine({ ...base, planRef: null, kind: "no_urgent_work", activity: "tidak relevan" }), "Bagas belum melaporkan task urgent-nya");
  assert.equal(flagLine({ ...base, kind: "something_new" }), "Bagas [1.06]: something new");
});

test("a very large day is shrunk list by list to stay under 3500 characters, never cut mid-section", async () => {
  const facts = await fixtureFacts();
  const many = (n: number): BriefOverdueItem[] =>
    Array.from({ length: n }, (_, i) => ({
      planRef: `aerolift:9.${String(i).padStart(2, "0")}`,
      id: `9.${String(i).padStart(2, "0")}`,
      title: "Langkah dengan judul yang cukup panjang untuk memakan tempat",
      pic: ["Bagas", "Gunawan"],
      daysLate: i + 1,
      statusText: "Berjalan",
      progressPct: 10,
    }));
  const big: MorningBriefFacts = {
    ...facts,
    plan: { ...facts.plan!, overdue: many(40) },
    flags: Array.from({ length: 30 }, (_, i) => ({ kind: "done_vs_plan", member: "Bagas", planRef: "aerolift:1.01", planStatus: "Berjalan", activity: null, note: `catatan panjang nomor ${i} `.repeat(4).trim() })),
    quiet: Array.from({ length: 30 }, (_, i) => ({ planRef: `aerolift:8.${i}`, id: `8.${i}`, title: "x", pic: ["Gunawan"], statusText: "Berjalan" })),
    planChanges: Array.from({ length: 30 }, (_, i) => ({ planRef: `aerolift:7.${i}`, id: `7.${i}`, changes: [{ field: "status", oldValue: "a", newValue: "b", text: "Berjalan → Selesai · progress 50% → 100%" }] })),
  };
  const llm = sanitizeBriefOutput(
    {
      ringkasan: "kalimat yang cukup panjang. ".repeat(20),
      prioritas: ["1.01", "1.02", "3.07", "3.08", "4.03"].map((planRef) => ({ planRef, alasan: "alasan yang panjang sekali ".repeat(10) })),
      hambatan: Array.from({ length: 5 }, () => ({ planRef: "6.02", masalah: "masalah ".repeat(30), saran: "saran ".repeat(50) })),
    },
    facts,
  );

  const text = renderMorningBrief(big, llm);

  assert.ok(text.length <= 3500, `length ${text.length}`);
  assert.ok(text.includes("*Lainnya*"), "the last section is still there because the lists shrank instead of the tail being cut");
  assert.ok(text.includes("*Terlambat (40)*"));
  assert.match(text, /• \+\d+ lainnya/);
});

test("the counts line uses Indonesian status words", async () => {
  const facts = await fixtureFacts();
  const counts = { Selesai: 1, Berjalan: 2, "Belum Mulai": 3, Blocked: 4, "Menunggu Input": 5, Revisi: 6 };
  const text = renderMorningBrief({ ...facts, plan: { ...facts.plan!, statusCounts: counts } }, null);
  assert.match(text, /1 selesai · 2 berjalan · 3 belum mulai · 4 terhambat · 5 menunggu input · 6 revisi/);
  assert.doesNotMatch(text, /blocked/i);
});

test("plan change lines: renumbered shows old -> new with the step, added and removed name their step", () => {
  const group = (over: Partial<BriefPlanChangeGroup>): BriefPlanChangeGroup => ({ planRef: "aerolift:5.04", id: "5.04", title: null, taskId: null, oldId: null, changes: [], ...over });
  assert.equal(
    planChangeLine(
      group({
        title: "QC dan pemasangan kedua box yang baru di mobil aerolift drone 2",
        oldId: "5.03",
        changes: [{ field: "renumbered", oldValue: "5.03", newValue: "5.04", text: "nomor berubah [5.03] → [5.04]" }],
      }),
    ),
    "[5.03] → [5.04] QC dan pemasangan kedua box yang baru di mobil aerolift drone 2",
  );
  assert.equal(
    planChangeLine(
      group({
        title: "Pengetesan",
        oldId: "5.04",
        id: "5.05",
        changes: [
          { field: "renumbered", oldValue: "5.04", newValue: "5.05", text: "nomor berubah [5.04] → [5.05]" },
          { field: "deadline", oldValue: "2026-10-09", newValue: "2026-10-12", text: "deadline Jum, 9 Okt → Sen, 12 Okt" },
        ],
      }),
    ),
    "[5.04] → [5.05] Pengetesan — deadline Jum, 9 Okt → Sen, 12 Okt",
  );
  assert.equal(
    planChangeLine(group({ id: "5.03", title: "Wiring box PSU", changes: [{ field: "added", oldValue: null, newValue: "A: Wiring box PSU", text: "langkah baru ditambahkan" }] })),
    "[5.03] Wiring box PSU — langkah baru ditambahkan",
  );
  assert.equal(
    planChangeLine(group({ id: "5.05", title: "Wiring box daya", changes: [{ field: "removed", oldValue: "A: Wiring box daya", newValue: null, text: "dihapus dari plan" }] })),
    "[5.05] Wiring box daya — dihapus dari plan",
  );
  assert.equal(planChangeLine(group({ id: "3.08", changes: [{ field: "status", oldValue: "a", newValue: "b", text: "Berjalan → Selesai" }] })), "[3.08] Berjalan → Selesai");
});

test("the PIC is not repeated after advice that already starts with their name, and is kept otherwise", async () => {
  const facts = await fixtureFacts();
  const render = (saran: string, pic: string) =>
    renderMorningBrief(facts, { ringkasan: "", prioritas: [], hambatan: [{ planRef: "aerolift:6.02", masalah: "konektor", saran, pic }] });
  assert.match(render("Bagas minta ETA ke supplier", "Bagas"), /→ Bagas minta ETA ke supplier$/m);
  assert.match(render("Minta ETA ke supplier", "Bagas"), /→ Minta ETA ke supplier \(Bagas\)$/m);
  assert.match(render("bagas dan Gunawan cek stok", "Bagas, Gunawan"), /→ bagas dan Gunawan cek stok$/m);
});

test("no_urgent_work shows at most five ids and counts the rest", () => {
  const base = { member: "Bagas", planRef: null, planStatus: null, activity: "x", note: null, kind: "no_urgent_work" };
  assert.equal(
    flagLine({ ...base, planIds: ["1.01", "1.02", "1.03", "1.04", "1.05", "1.06", "1.07"] }),
    "Bagas belum melaporkan task urgent-nya ([1.01] [1.02] [1.03] [1.04] [1.05] +2)",
  );
});

