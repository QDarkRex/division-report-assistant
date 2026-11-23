import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../db/testing.ts";
import { llmInvocations, reportItems, weeklyRecaps, weeklyStreamRecaps, workStreams } from "../db/schema.ts";
import { createMember } from "../members/service.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { WORK_STREAM_SEEDS } from "../scripts/seed-work-streams-20261123.ts";
import { buildWeeklyRecapFacts, type WeeklyRecapFacts } from "./facts.ts";
import { buildRecapUserContent, RECAP_SYSTEM_PROMPT, sanitizeRecapOutput, stripInlineAliases, stripLeadingDay, type RecapLlmRaw, type RecapPlan } from "./llm.ts";
import { buildRecapView, dayLabelOf, MAX_RECAP_CHARS, renderFallbackRecap, renderWeeklyRecap } from "./render.ts";
import { composeWeeklyRecap, persistRefusal, persistWeeklyRecap, recapWeekStartFor } from "./weekly.ts";
import { buildWeeklyRecapRows } from "../sheets/export.ts";

const WEEK = { year: 2026, month: 11, day: 16 }; // Monday; the week ends Sunday 22 Nov
const NOW = new Date("2026-11-22T12:00:00.000Z"); // Sunday 19:00 Jakarta

type Status = "worked_on" | "in_progress" | "testing" | "blocked" | "done";
interface Seed {
  day: string;
  member: string;
  activity: string;
  result?: string;
  obstacle?: string;
  status?: Status;
  stream?: string; // persisted assignment (previous weeks)
  kind?: "regular" | "overtime";
}

const THIS_WEEK: Seed[] = [
  { day: "2026-11-16", member: "Andre", activity: "Soldering konektor aviasi 25 pin box controller Truck", result: "selesai 100%", status: "done" },
  { day: "2026-11-16", member: "Andre", activity: "Wiring box power docking Truck", status: "in_progress" },
  { day: "2026-11-16", member: "Nugrahadi", activity: "Perapihan wiring box controller Truck", result: "95%", status: "in_progress" },
  { day: "2026-11-17", member: "Andre", activity: "Wiring box kontroler Truck sesuai ceklis", result: "selesai", status: "done" },
  { day: "2026-11-18", member: "Nugrahadi", activity: "Wiring docking panel Truck demo Alpha", result: "65%", status: "in_progress" },
  { day: "2026-11-19", member: "Andre", activity: "Komponen 6N137 dan ISO1050 untuk PCB kontroler Truck belum ada", obstacle: "menunggu kedatangan komponen", status: "blocked" },
  { day: "2026-11-20", member: "Nugrahadi", activity: "Troubleshooting program motor pintu lifter Truck", result: "done", status: "done" },
  { day: "2026-11-16", member: "Bagas", activity: "Troubleshooting BQ76952 I2C ke microcontroller BMS", result: "teratasi", status: "done" },
  { day: "2026-11-16", member: "Bagas", activity: "Balancing BMS BQ76952", result: "belum optimal", status: "in_progress" },
  { day: "2026-11-18", member: "Bagas", activity: "Shutdown sleep wake BQ76952 BMS", result: "100%", status: "done" },
  { day: "2026-11-20", member: "Bagas", activity: "Balancing PCB BMS 16S", result: "belum optimal", status: "testing" },
  { day: "2026-11-16", member: "Arief", activity: "Sensor Enviro dan box monitoring terpasang di Semarang", status: "done" },
  { day: "2026-11-17", member: "Arief", activity: "Pelatihan dan demo PANTAU", status: "done" },
  { day: "2026-11-17", member: "Arief", activity: "Dashboard PANTAU symbol overheat alarm tidak muncul di map", obstacle: "symbol tidak muncul", status: "blocked" },
  { day: "2026-11-19", member: "Setiawan", activity: "Uji rangkaian cutoff baterai controller panel LattePanda", result: "INA219 korsleting dan mengeluarkan asap", obstacle: "penyebab belum diketahui", status: "blocked" },
  { day: "2026-11-20", member: "Setiawan", activity: "Cutoff baterai 6S LattePanda via relay controller panel", result: "putus di 20 V normal", status: "done" },
  { day: "2026-11-20", member: "Setiawan", activity: "Uji TX-RX GPS LoRa controller panel", result: "21 V stabil, sampai 150 m", status: "done" },
  { day: "2026-11-16", member: "Rafi", activity: "Pengambilan barang pembelian di inventaris", status: "in_progress" },
  { day: "2026-11-18", member: "Rafi", activity: "Sortir komponen ke rak inventaris", status: "done" },
  { day: "2026-11-19", member: "Kurnia", activity: "Belajar MQTT ESP32 buzzer", status: "worked_on" },
  { day: "2026-11-21", member: "Andre", activity: "Rapikan kabel box Truck (lembur)", status: "worked_on", kind: "overtime" },
  { day: "2026-11-22", member: "Bagas", activity: "Solder PCB BMS lembur Minggu", status: "worked_on", kind: "overtime" },
];

const PREV_WEEK: Seed[] = [
  { day: "2026-11-09", member: "Andre", activity: "Tes PCB merah Truck", status: "done", stream: "adm-box-truck" },
  { day: "2026-11-10", member: "Andre", activity: "Wiring box kontroler Truck 80%", status: "in_progress", stream: "adm-box-truck" },
  { day: "2026-11-12", member: "Arief", activity: "Uji suara mlink", status: "in_progress", stream: "mlink" },
  { day: "2026-11-13", member: "Arief", activity: "GPS manual mlink tidak realtime", status: "blocked", obstacle: "tidak realtime", stream: "mlink" },
  { day: "2026-11-14", member: "Kurnia", activity: "Routing PCB Pulsar", status: "done", stream: "pulsar" },
];

async function seedWorld(): Promise<TestDb> {
  const db = await createTestDb();
  const keep = new Set(["adm-box-truck", "bms-custom", "enviro-pantau", "controller-panel-cutoff", "mlink", "pulsar", "pengadaan-inventaris", "pembelajaran-riset", "lain-lain"]);
  await db.insert(workStreams).values(WORK_STREAM_SEEDS.filter((s) => keep.has(s.streamId)).map((s) => ({ ...s, origin: "seed" })));

  const members = new Map<string, string>();
  for (const s of [...PREV_WEEK, ...THIS_WEEK]) {
    if (!members.has(s.member)) members.set(s.member, (await createMember(db, { preferredName: s.member })).memberId);
  }
  const revisionOf = new Map<string, string>(); // one revision per report, several items on it
  for (const s of [...PREV_WEEK, ...THIS_WEEK]) {
    const report = await getOrCreateDailyReport(db, members.get(s.member)!, s.day, s.kind ?? "regular");
    if (!revisionOf.has(report.reportId)) revisionOf.set(report.reportId, (await addRevision(db, report.reportId, "report")).revisionId);
    const latest = { revisionId: revisionOf.get(report.reportId)! };
    await addReportItem(db, latest.revisionId, { activity: s.activity, ...(s.result ? { result: s.result } : {}), ...(s.obstacle ? { obstacle: s.obstacle } : {}), status: s.status ?? "unknown" });
    if (s.stream) {
      await db.update(reportItems).set({ workStreamId: s.stream }).where(eq(reportItems.activity, s.activity));
    }
  }
  return db;
}

/** What a decent model would answer for the fixture: keyword -> stream, one bullet per stream, one perhatian per problem. */
function modelAnswer(facts: WeeklyRecapFacts): RecapLlmRaw {
  const streamOf = (a: string): string =>
    /truck|ISO1050/i.test(a) ? "adm-box-truck" : /BMS|BQ76952/i.test(a) ? "bms-custom" : /PANTAU|Enviro/i.test(a) ? "enviro-pantau" : /cutoff|LoRa|INA219/i.test(a) ? "controller-panel-cutoff" : /inventaris|pembelian/i.test(a) ? "pengadaan-inventaris" : "pembelajaran-riset";
  const assignments = facts.items.map((i) => ({ itemId: i.alias, streamId: streamOf(i.activity) }));
  const ids = (re: RegExp) => facts.items.filter((i) => re.test(i.activity)).map((i) => i.alias);
  return {
    assignments,
    streams: [
      { streamId: "adm-box-truck", bullets: [{ text: "Senin: konektor aviasi 25 pin selesai disolder; wiring box dan docking panel berjalan", evidence: ids(/konektor aviasi|Wiring box|docking panel/i) }] },
      { streamId: "bms-custom", bullets: [{ text: "BQ76952: I2C teratasi dan sleep-wake lolos; balancing masih belum optimal", evidence: ids(/BQ76952|Balancing/i) }] },
    ],
    perhatian: [
      { text: "INA219 korsleting dan berasap saat uji LattePanda", kind: "insiden", evidence: ids(/cutoff baterai controller panel LattePanda/i) },
      { text: "Komponen 6N137 dan ISO1050 belum ada", kind: "komponen", evidence: ids(/ISO1050/) },
      { text: "Simbol alarm overheat PANTAU tidak muncul di peta", kind: "tertahan", evidence: ids(/overheat/) },
    ],
  };
}

function chat(content: unknown) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 5000, completion_tokens: 900 } }), text: async () => "" } as Response;
}

async function composeWithModel(db: TestDb, answer: (facts: WeeklyRecapFacts) => unknown) {
  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const fetchImpl = (async () => chat(answer(facts))) as unknown as typeof fetch;
  return composeWeeklyRecap(db, { llm: { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m" } }, WEEK, NOW);
}

// --- facts ------------------------------------------------------------------------------

test("facts: the week is Monday..Sunday, regular and overtime items both count, aliases map back in code", async () => {
  const db = await seedWorld();
  const facts = await buildWeeklyRecapFacts(db, WEEK);

  assert.equal(facts.weekStart, "2026-11-16");
  assert.equal(facts.weekEnd, "2026-11-22");
  assert.equal(facts.itemCount, THIS_WEEK.length);
  assert.equal(facts.items.filter((i) => i.kind === "overtime").length, 2);
  assert.ok(facts.items.some((i) => i.day === "2026-11-22"), "Sunday is inside the week");
  assert.deepEqual(facts.items.map((i) => i.alias), facts.items.map((_, n) => `i${n + 1}`));
  assert.ok(facts.items.every((i) => /^[0-9a-f-]{36}$/.test(i.itemId)));
  assert.equal(facts.prevItemCount, PREV_WEEK.length);
  assert.equal(facts.prevBlockedCount, 1);
  assert.equal(facts.blockedCount, 3);
  assert.equal(facts.memberCount, 7);
  assert.equal(facts.prevActivity["adm-box-truck"]?.prevCount, 2);

  const content = buildRecapUserContent(facts);
  assert.doesNotMatch(content, /[0-9a-f]{8}-[0-9a-f]{4}-/, "the model never sees a UUID");
  const payload = JSON.parse(content) as { panduanBullet: string; registry: Array<{ id: string; butirPekanLalu?: number }> };
  assert.match(payload.panduanBullet, />= 20 item = 2-3 bullet; 8-19 item = 1-2 bullet; < 8 item = 1 bullet/);
  assert.equal(payload.registry.find((r) => r.id === "adm-box-truck")?.butirPekanLalu, 2);
  assert.equal(recapWeekStartFor(NOW).day, 16, "Sunday evening belongs to the week that is ending");
});

test("facts: only the latest revision of a report counts", async () => {
  const db = await seedWorld();
  const [bagas] = await db.query.members.findMany({ where: (m, { eq: e }) => e(m.preferredName, "Bagas") });
  const report = await getOrCreateDailyReport(db, bagas!.memberId, "2026-11-16");
  const second = await addRevision(db, report.reportId, "koreksi");
  await addReportItem(db, second.revisionId, { activity: "Satu-satunya butir setelah koreksi", status: "done" });

  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const bagasMonday = facts.items.filter((i) => i.member === "Bagas" && i.day === "2026-11-16");
  assert.deepEqual(bagasMonday.map((i) => i.activity), ["Satu-satunya butir setelah koreksi"]);
});

// --- validation ----------------------------------------------------------------------------

test("sanitize drops evidence outside this week, bullets left without evidence, and cross-stream evidence", async () => {
  const db = await seedWorld();
  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const truck = facts.items.find((i) => /Truck/.test(i.activity))!.alias;
  const bms = facts.items.find((i) => /BQ76952/.test(i.activity))!.alias;

  const plan = sanitizeRecapOutput(
    {
      assignments: [{ itemId: truck, streamId: "adm-box-truck" }, { itemId: bms, streamId: "bms-custom" }],
      streams: [
        {
          streamId: "adm-box-truck",
          bullets: [
            { text: "Dikarang", evidence: ["i999", "r12"] },
            { text: "Campuran bukti valid dan palsu", evidence: [truck, bms, "i999"] },
            { text: "Tanpa bukti", evidence: [] },
          ],
        },
      ],
      perhatian: [{ text: "Tanpa bukti valid", kind: "insiden", evidence: ["zzz"] }, { text: "Ada bukti yang valid disini", kind: "aneh", evidence: [bms] }],
    },
    facts,
  );

  assert.deepEqual(plan.bullets.get("adm-box-truck"), [{ text: "Campuran bukti valid dan palsu", evidence: [truck] }], "only the valid evidence in the same stream survives");
  assert.deepEqual(plan.perhatian, [{ text: "Ada bukti yang valid disini", kind: "lain", evidence: [bms] }], "unknown kind becomes lain");
});

test("sanitize strips leading weekday and date tokens, truncates, and sends unknown streams to lain-lain", async () => {
  const db = await seedWorld();
  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const [a, b, c] = facts.items.map((i) => i.alias);

  const plan = sanitizeRecapOutput(
    {
      assignments: [
        { itemId: a!, streamId: "adm-box-truck" },
        { itemId: b!, streamId: "stream-ngawur" },
        { itemId: c!, streamId: "new-solar-charger" },
        { itemId: "i9999", streamId: "bms-custom" },
      ],
      streams: [
        { streamId: "new-solar-charger", name: "Solar charger", shortName: "Solar", bullets: [] },
        { streamId: "adm-box-truck", bullets: [{ text: `Senin–Rabu: ${"kata ".repeat(80)}`, evidence: [a!] }] },
      ],
      perhatian: [{ text: "Kamis, 19 Nov: INA219 berasap saat uji", kind: "insiden", evidence: [a!] }],
    },
    facts,
  );

  assert.equal(plan.assignment.get(b!), "lain-lain");
  assert.equal(plan.assignment.get(c!), "new-solar-charger");
  assert.deepEqual(plan.newStreams.find((s) => s.streamId === "new-solar-charger"), { streamId: "new-solar-charger", name: "Solar charger", shortName: "Solar" });
  assert.ok(!plan.assignment.has("i9999"));
  assert.equal(plan.assignment.size, facts.items.length, "every item gets exactly one stream");
  const bullet = plan.bullets.get("adm-box-truck")![0]!;
  assert.ok(!/^Senin/.test(bullet.text) && bullet.text.length <= 160);
  assert.equal(plan.perhatian[0]?.text, "INA219 berasap saat uji");
});

test("stripLeadingDay only touches a leading day/date label", () => {
  assert.equal(stripLeadingDay("Senin: wiring selesai"), "wiring selesai");
  assert.equal(stripLeadingDay("Sen–Rab: wiring"), "wiring");
  assert.equal(stripLeadingDay("Selasa dan Kamis - uji"), "uji");
  assert.equal(stripLeadingDay("16 Nov: uji"), "uji");
  assert.equal(stripLeadingDay("Rabu, 18 Nov: uji"), "uji");
  assert.equal(stripLeadingDay("Wiring selesai hari Senin"), "Wiring selesai hari Senin");
  assert.equal(stripLeadingDay("Minggu lalu belum jalan"), "Minggu lalu belum jalan");
});

test("the system prompt carries the bake-off rules and the new ones", () => {
  assert.match(RECAP_SYSTEM_PROMPT, /DILARANG menulis nama hari/);
  assert.match(RECAP_SYSTEM_PROMPT, /berstatus done/);
  assert.match(RECAP_SYSTEM_PROMPT, /teratasi/);
  assert.match(RECAP_SYSTEM_PROMPT, /maksimal 160 karakter/);
  assert.match(RECAP_SYSTEM_PROMPT, /20 item atau lebih = 2-3 bullet; 8-19 item = 1-2 bullet; kurang dari 8 = 1 bullet/);
  assert.match(RECAP_SYSTEM_PROMPT, /SATU pekerjaan/);
  assert.match(RECAP_SYSTEM_PROMPT, /diperbaiki, normal, berhasil, selesai, atau diganti/);
  assert.match(RECAP_SYSTEM_PROMPT, /"insiden"/);
});

// --- day labels -------------------------------------------------------------------------------

test("day labels come from the evidence days", () => {
  assert.equal(dayLabelOf(["2026-11-16"]), "Sen");
  assert.equal(dayLabelOf(["2026-11-16", "2026-11-17", "2026-11-18"]), "Sen–Rab");
  assert.equal(dayLabelOf(["2026-11-16", "2026-11-19"]), "Sen, Kam");
  assert.equal(dayLabelOf(["2026-11-16", "2026-11-17"]), "Sen, Sel");
  assert.equal(dayLabelOf(["2026-11-16", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-22"]), "Sen, Rab–Jum, Min");
  assert.equal(dayLabelOf(["2026-11-19", "2026-11-19"]), "Kam");
});

// --- end to end with a mocked model ------------------------------------------------------

test("compose: header numbers, computed day labels, ordered perhatian and the stalled line", async () => {
  const db = await seedWorld();
  const recap = await composeWithModel(db, modelAnswer);

  assert.equal(recap.llmError, null);
  const text = recap.text;
  assert.ok(text.length <= MAX_RECAP_CHARS);
  assert.ok(text.startsWith("*REKAP MINGGUAN DIVISI EE*\nSenin 16 – Minggu 22 Nov 2026\n7 orang melapor · 22 butir kerja (pekan lalu 5) · 3 tertahan (pekan lalu 1)"), text);
  assert.match(text, /\*1\. Aerolift Drone Mobil – Box Kontroler & Box Power Truck\/Docking\* \(\d+ butir, pekan lalu 2 · /);
  // the model wrote "Senin:" itself; the label printed is the one computed from the evidence days
  const truck = recap.view!.streams.find((s) => s.streamId === "adm-box-truck")!;
  assert.match(truck.bullets[0]!.label, /^Sen/);
  assert.doesNotMatch(text, /• Senin:/);
  const insiden = text.indexOf("INA219 korsleting");
  const komponen = text.indexOf("Komponen 6N137");
  const tertahan = text.indexOf("Simbol alarm");
  assert.ok(insiden > 0 && insiden < komponen && komponen < tertahan, "insiden, komponen, tertahan");
  assert.ok(text.includes("• Tanpa laporan pekan ini: Pulsar & Epsilon (terakhir 14 Nov) · Radio mlink (terakhir 13 Nov)"));
  const [row] = await db.select().from(llmInvocations);
  assert.equal(row?.feature, "scheduled_summary");
});

test("stalled: streams of the previous two weeks without an item this week, none for active ones", async () => {
  const db = await seedWorld();
  const recap = await composeWithModel(db, modelAnswer);
  const ids = recap.view!.stalled.map((s) => s.streamId);
  assert.deepEqual(ids, ["pulsar", "mlink"].sort((a, b) => (a === "pulsar" ? -1 : 1)), "most recent last day first (Pulsar 14 Nov, mlink 13 Nov)");
  assert.ok(!ids.includes("adm-box-truck"));
  assert.equal(recap.view!.stalled.find((s) => s.streamId === "mlink")?.lastDay, "2026-11-13");
});

// --- trimming -------------------------------------------------------------------------------------

test("render trims to 3000 characters, dropping bullets first and never an insiden line", async () => {
  const db = await seedWorld();
  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const answer = modelAnswer(facts);
  const long = (tag: string) => `${tag} ${"komponen uji ".repeat(12)}`.slice(0, 158);
  const byStream = new Map<string, string[]>();
  for (const a of answer.assignments) byStream.set(a.streamId, [...(byStream.get(a.streamId) ?? []), a.itemId]);
  const plan: RecapPlan = {
    assignment: new Map(answer.assignments.map((a) => [a.itemId, a.streamId])),
    newStreams: [],
    bullets: new Map([...byStream].map(([id, items]) => [id, [0, 1, 2, 3].map((n) => ({ text: long(`b${id}${n}`), evidence: [items[0]!] }))])),
    perhatian: [
      ...Array.from({ length: 8 }, (_, n) => ({ text: long(`lain${n}`), kind: "lain" as const, evidence: [facts.items[n]!.alias] })),
      { text: long("tertahan-x"), kind: "tertahan" as const, evidence: [facts.items[0]!.alias] },
      { text: long("komponen-x"), kind: "komponen" as const, evidence: [facts.items[1]!.alias] },
      { text: long("INSIDEN-A"), kind: "insiden" as const, evidence: [facts.items[2]!.alias] },
      { text: long("INSIDEN-B"), kind: "insiden" as const, evidence: [facts.items[3]!.alias] },
    ],
  };
  const view = buildRecapView(facts, plan);
  const untrimmedLength = view.streams.reduce((n, s) => n + s.bullets.length * 165, 0) + 12 * 165;
  assert.ok(untrimmedLength > MAX_RECAP_CHARS, "the fixture really is too long");

  const text = renderWeeklyRecap(view);
  assert.ok(text.length <= MAX_RECAP_CHARS, `length ${text.length}`);
  assert.match(text, /INSIDEN-A/);
  assert.match(text, /INSIDEN-B/);
  assert.ok(text.indexOf("INSIDEN-A") < text.indexOf("komponen-x") || !text.includes("komponen-x"));
  assert.match(text, /\*1\. /, "top stream kept at least one bullet");
});

// --- fallback ----------------------------------------------------------------------------------------

test("when the model call fails the deterministic fallback is returned, with counts and the blocked items", async () => {
  const db = await seedWorld();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const fetchImpl = (async () => {
      throw new Error("gateway down");
    }) as unknown as typeof fetch;
    const recap = await composeWeeklyRecap(db, { llm: { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m" } }, WEEK, NOW);

    assert.match(recap.llmError ?? "", /gateway down/);
    assert.equal(recap.plan, null);
    assert.ok(recap.text.startsWith("*REKAP MINGGUAN DIVISI EE*"));
    assert.match(recap.text, /tidak tersedia pekan ini/);
    assert.match(recap.text, /\*Butir tertahan\*/);
    assert.match(recap.text, /Komponen 6N137 dan ISO1050.*menunggu kedatangan komponen \(Andre\)/);
    assert.match(recap.text, /Belum dikelompokkan: 22/);
    assert.ok(recap.text.length <= MAX_RECAP_CHARS);
    assert.ok(errors.length > 0, "the failure is logged");
    const [inv] = await db.select().from(llmInvocations);
    assert.match(inv?.failureReason ?? "", /gateway down/);
  } finally {
    console.error = original;
  }
});

test("without an LLM, or without any item, the fallback is what is rendered", async () => {
  const db = await seedWorld();
  const noLlm = await composeWeeklyRecap(db, {}, WEEK, NOW);
  assert.equal(noLlm.llmError, "LLM tidak dikonfigurasi");
  const empty = await composeWeeklyRecap(db, {}, { year: 2026, month: 12, day: 7 }, NOW);
  assert.match(empty.text, /0 orang melapor · 0 butir kerja/);
  assert.equal(renderFallbackRecap(await buildWeeklyRecapFacts(db, WEEK)), noLlm.text);
});

// --- persistence + sheet -----------------------------------------------------------------------------

test("persist stores assignments, new streams, per-stream rows and the message; a re-run overwrites", async () => {
  const db = await seedWorld();
  const recap = await composeWithModel(db, (facts) => {
    const answer = modelAnswer(facts);
    const last = answer.assignments[answer.assignments.length - 1]!;
    last.streamId = "new-solar-charger"; // the model proposes a stream
    answer.streams.push({ streamId: "new-solar-charger", name: "Solar Charger", shortName: "Solar", bullets: [] });
    return answer;
  });
  await persistWeeklyRecap(db, recap, NOW);
  await persistWeeklyRecap(db, recap, null); // backfill-style re-run must not erase sentAt

  const streams = await db.select().from(workStreams);
  assert.equal(streams.find((s) => s.streamId === "new-solar-charger")?.origin, "llm");
  const assigned = await db.select().from(reportItems).where(eq(reportItems.workStreamId, "new-solar-charger"));
  assert.equal(assigned.length, 1);

  const rows = await db.select().from(weeklyStreamRecaps).where(eq(weeklyStreamRecaps.weekStart, "2026-11-16"));
  assert.equal(rows.reduce((n, r) => n + r.itemCount, 0), recap.facts.itemCount);
  const truck = rows.find((r) => r.streamId === "adm-box-truck")!;
  assert.equal(truck.prevItemCount, 2);
  assert.match(truck.members, /Andre \d+/);
  assert.ok((truck.bullets as Array<{ evidenceItemIds: string[] }>)[0]!.evidenceItemIds.every((id) => /^[0-9a-f-]{36}$/.test(id)));

  const [stored] = await db.select().from(weeklyRecaps);
  assert.equal(stored?.text, recap.text);
  assert.equal(stored?.llmOk, true);
  assert.ok(stored?.sentAt, "the send time survives a re-run");

  const sheet = await buildWeeklyRecapRows(db);
  assert.deepEqual(sheet[0], ["Pekan", "ID aliran", "Nama aliran", "Butir", "Orang", "Ringkasan", "Tertahan", "Hambatan", "Δ vs pekan lalu", "Bukti (report_item id)"]);
  const sheetTruck = sheet.find((r) => r[1] === "adm-box-truck")!;
  assert.equal(sheetTruck[0], "2026-11-16");
  assert.match(sheetTruck[5]!, /^Sen/);
  assert.match(sheetTruck[8]!, /^[+-]\d+$/);
  assert.match(sheetTruck[9]!, /[0-9a-f-]{36}/);
});

// --- perhatian cap, folding of bare streams, trimming order, persist refusal ----------------------

type PerhatianSeed = { text: string; kind: "insiden" | "komponen" | "tertahan" | "lain"; item: number };

/** Six streams with items; bullets for the first `withBullets` of them (0..4 each); the given perhatian lines (item = index into the day-sorted items). */
async function heavyView(perhatianSeed: PerhatianSeed[], withBullets: string[]) {
  const db = await seedWorld();
  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const answer = modelAnswer(facts);
  const long = (tag: string) => `${tag} ${"komponen uji ".repeat(12)}`.slice(0, 158);
  const byStream = new Map<string, string[]>();
  for (const a of answer.assignments) byStream.set(a.streamId, [...(byStream.get(a.streamId) ?? []), a.itemId]);
  const plan: RecapPlan = {
    assignment: new Map(answer.assignments.map((a) => [a.itemId, a.streamId])),
    newStreams: [],
    bullets: new Map([...byStream].filter(([id]) => withBullets.includes(id)).map(([id, items]) => [id, [0, 1, 2, 3].map((n) => ({ text: long(`b-${id}-${n}`), evidence: [items[0]!] }))])),
    perhatian: perhatianSeed.map((p) => ({ text: long(p.text), kind: p.kind, evidence: [facts.items[p.item]!.alias] })),
  };
  return { facts, view: buildRecapView(facts, plan), byStream };
}

const section = (text: string) => text.split("*PERLU PERHATIAN*\n")[1]!.split("\n");

test("perhatian is capped at 6 lines by kind then newest evidence day, with a pointer to the spreadsheet", async () => {
  const seeds: PerhatianSeed[] = [
    { text: "LAIN-a", kind: "lain", item: 1 }, { text: "LAIN-b", kind: "lain", item: 2 }, { text: "LAIN-c", kind: "lain", item: 3 },
    { text: "TERT-old", kind: "tertahan", item: 0 }, { text: "TERT-new", kind: "tertahan", item: 20 }, { text: "TERT-mid", kind: "tertahan", item: 10 },
    { text: "KOMP-old", kind: "komponen", item: 0 }, { text: "KOMP-new", kind: "komponen", item: 21 },
    { text: "INSIDEN-1", kind: "insiden", item: 5 },
    { text: "LAIN-d", kind: "lain", item: 4 }, { text: "LAIN-e", kind: "lain", item: 5 }, { text: "LAIN-f", kind: "lain", item: 6 },
  ];
  const { view } = await heavyView(seeds, ["adm-box-truck", "bms-custom"]);
  assert.equal(view.perhatian.length, 6);
  assert.equal(view.perhatianCut, 6);
  const text = renderWeeklyRecap(view);
  const lines = section(text);
  assert.equal(lines.filter((l) => l.startsWith("• ") && !l.includes("lainnya di spreadsheet") && !l.includes("Tanpa laporan")).length, 6);
  assert.ok(lines.includes("• +6 lainnya di spreadsheet"));
  const order = ["INSIDEN-1", "KOMP-new", "KOMP-old", "TERT-new", "TERT-mid", "TERT-old"].map((t) => text.indexOf(t));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1]!)), `order ${order}`);
  assert.ok(!text.includes("LAIN-"), "lain only fills what is left, and nothing is left");
});

test("every insiden line is kept even beyond the cap, and nothing else then", async () => {
  const seeds: PerhatianSeed[] = [
    ...Array.from({ length: 8 }, (_, n) => ({ text: `INSIDEN-${n}`, kind: "insiden" as const, item: n })),
    { text: "KOMP-x", kind: "komponen", item: 9 }, { text: "LAIN-x", kind: "lain", item: 9 },
  ];
  const { view } = await heavyView(seeds, ["adm-box-truck"]);
  const text = renderWeeklyRecap(view);
  assert.equal(view.perhatian.length, 8);
  for (let n = 0; n < 8; n++) assert.ok(text.includes(`INSIDEN-${n}`));
  assert.ok(!text.includes("KOMP-x") && text.includes("• +2 lainnya di spreadsheet"));
});

test("a stream without a bullet is folded into Lainnya instead of printing an empty header", async () => {
  const seeds: PerhatianSeed[] = Array.from({ length: 12 }, (_, n) => ({ text: `P${n}`, kind: n < 2 ? ("insiden" as const) : ("komponen" as const), item: n }));
  const { view } = await heavyView(seeds, ["adm-box-truck", "bms-custom", "enviro-pantau"]);
  const text = renderWeeklyRecap(view);
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    if (/^\*\d+\. /.test(l)) assert.ok(lines[i + 1]?.startsWith("• "), `bare header: ${l}`);
  });
  assert.equal(lines.filter((l) => /^\*\d+\. /.test(l)).length, 3, "only streams with bullets get a block");
  assert.match(text, /\*Lainnya:\* .*Controller Panel & Cutoff 3/);
  assert.match(text, /Pembelajaran & Riset 1/);
  assert.match(text, /Pengadaan & Inventaris 2/);
});

test("trimming order: lower streams lose bullets first, then fold; six streams with 12 perhatian lines still fit", async () => {
  const seeds: PerhatianSeed[] = Array.from({ length: 12 }, (_, n) => ({ text: `P${n}`, kind: n === 0 ? ("insiden" as const) : n < 5 ? ("komponen" as const) : ("tertahan" as const), item: n }));
  const all = ["adm-box-truck", "bms-custom", "enviro-pantau", "controller-panel-cutoff", "pengadaan-inventaris", "pembelajaran-riset"];
  const { view } = await heavyView(seeds, all);
  const text = renderWeeklyRecap(view);
  assert.ok(text.length <= MAX_RECAP_CHARS, `length ${text.length}`);
  assert.ok(text.includes("P0"), "insiden kept");
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    if (/^\*\d+\. /.test(l)) assert.ok(lines[i + 1]?.startsWith("• "), `bare header: ${l}`);
  });
  const blocks = lines.filter((l) => /^\*\d+\. /.test(l)).length;
  assert.ok(blocks >= 3, "the top streams survive with bullets");
  assert.ok(lines.filter((l) => l.startsWith("• ") && /^• [A-Z][a-z]/.test(l) && l.includes("b-")).length >= blocks, "at least one bullet per block");
});

test("--persist is refused when the LLM step did not succeed", async () => {
  const db = await seedWorld();
  const failed = await composeWeeklyRecap(db, {}, WEEK, NOW);
  assert.match(persistRefusal(failed) ?? "", /LLM tidak dikonfigurasi.*nothing persisted/);
  const ok = await composeWithModel(db, modelAnswer);
  assert.equal(persistRefusal(ok), null);
});

// --- inline aliases, ";" joins, budget, mid-word cuts, resolved problems ---------------------------

test("code splits ';' joins and inline aliases into pieces with their own evidence and day labels, within the per-stream budget", async () => {
  const db = await seedWorld();
  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const alias = (re: RegExp) => facts.items.find((i) => re.test(i.activity))!.alias;
  const mon1 = alias(/Soldering konektor aviasi/);
  const mon2 = alias(/Wiring box power docking/);
  const fri = alias(/Troubleshooting program motor/);
  const wed = alias(/docking panel Truck/);
  const thu = alias(/ISO1050/);
  const long = `Perapihan wiring kabel box kontroler ${"dan pengecekan ".repeat(14)}selesai`;
  const answer = modelAnswer(facts);
  answer.streams = [
    {
      streamId: "adm-box-truck",
      bullets: [
        {
          // the real shape of the bad output: ';'-joined, aliases written into the text, no usable "evidence" field
          text: `Wiring box power dirapikan penuh (${mon1}, ${mon2}); konektor aviasi 25 pin 100% (${fri}); docking panel 65% ${wed}; ${thu} pendek; ${long}`,
          evidence: [mon1],
        },
      ],
    },
  ];
  const plan = sanitizeRecapOutput(answer, facts);
  const view = buildRecapView(facts, plan);
  const truck = view.streams.find((s) => s.streamId === "adm-box-truck")!;

  assert.equal(truck.itemCount, 8);
  assert.equal(truck.bullets.length, 2, "8-19 items: at most two pieces survive, the best-evidenced ones");
  assert.deepEqual(truck.bullets.map((b) => b.label), ["Sen", "Jum"], "each piece is labelled from its own evidence, in chronological order");
  assert.equal(truck.bullets[0]!.text, "Wiring box power dirapikan penuh");
  assert.equal(truck.bullets[1]!.text, "konektor aviasi 25 pin 100%");
  assert.ok(!truck.bullets.some((b) => b.text.length < 15), "short fragments such as 'pendek' are dropped");
  assert.ok(!/\bi\d+\b/.test(renderWeeklyRecap(view)), "no alias token reaches the group message");
});

test("a piece longer than 160 characters is cut at a word boundary", () => {
  const original = `Perapihan wiring kabel box kontroler ${"dan pengecekan ".repeat(14)}selesai`;
  const facts = { items: [{ alias: "i1", itemId: "x", day: "2026-11-16", member: "A", kind: "regular", activity: "a", result: null, obstacle: null, status: "done", workStreamId: null }], registry: [{ streamId: "adm-box-truck", name: "N", shortName: "N", description: "" }] } as unknown as WeeklyRecapFacts;
  const plan = sanitizeRecapOutput({ assignments: [{ itemId: "i1", streamId: "adm-box-truck" }], streams: [{ streamId: "adm-box-truck", bullets: [{ text: original, evidence: ["i1"] }] }], perhatian: [] }, facts);
  const text = plan.bullets.get("adm-box-truck")![0]!.text;
  assert.ok(text.endsWith("…") && text.length <= 160);
  const body = text.slice(0, -1);
  assert.ok(original.startsWith(body) && original[body.length] === " ", "cut falls on a space, not inside a word");
});

test("perhatian: aliases are stripped and split, resolved problems are dropped, an unresolved insiden is kept", async () => {
  const db = await seedWorld();
  const facts = await buildWeeklyRecapFacts(db, WEEK);
  const alias = (re: RegExp) => facts.items.find((i) => re.test(i.activity))!.alias;
  const [a, b, c] = [alias(/ISO1050/), alias(/overheat/), alias(/cutoff baterai controller panel LattePanda/)];
  const answer = modelAnswer(facts);
  answer.perhatian = [
    { text: `MCB untuk instalasi masih dalam pembelian (${a}); MCB pengganti sudah dipasang (${b})`, kind: "komponen", evidence: [a] },
    { text: `CC/CV tertahan 0 V (${a}, ${b}); output kini stabil sesuai target (${c})`, kind: "tertahan", evidence: [a] },
    { text: `Masalah belum teratasi: simbol alarm overheat tidak muncul (${b})`, kind: "tertahan", evidence: [b] },
    { text: `INA219 korsleting dan mengeluarkan asap saat uji LattePanda (${c}); penyebab belum diketahui`, kind: "insiden", evidence: [c] },
  ];
  const plan = sanitizeRecapOutput(answer, facts);
  const texts = plan.perhatian.map((p) => p.text);

  assert.ok(!texts.some((t) => /MCB|CC\/CV/.test(t)), "lines that state their own resolution are dropped whole");
  assert.deepEqual(texts, ["Masalah belum teratasi: simbol alarm overheat tidak muncul", "INA219 korsleting dan mengeluarkan asap saat uji LattePanda, penyebab belum diketahui"]);
  assert.equal(plan.perhatian.find((p) => p.kind === "insiden")?.evidence[0], c);
  assert.ok(!/\bi\d+\b/.test(renderWeeklyRecap(buildRecapView(facts, plan))));
});

test("stripInlineAliases tidies what the alias removal leaves behind", () => {
  assert.equal(stripInlineAliases("Wiring dirapikan (i2, i3, i11) penuh"), "Wiring dirapikan penuh");
  assert.equal(stripInlineAliases("uji berjalan ()"), "uji berjalan");
  assert.equal(stripInlineAliases("uji i2, i3, selesai"), "uji, selesai");
  assert.equal(stripInlineAliases("chip I2C terbaca"), "chip I2C terbaca");
});
