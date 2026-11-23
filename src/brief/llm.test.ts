import assert from "node:assert/strict";
import { test } from "node:test";
import { llmInvocations } from "../db/schema.ts";
import { buildMorningBriefFacts } from "./facts.ts";
import {
  BRIEF_SYSTEM_PROMPT,
  buildBriefUserContent,
  requestBriefInsights,
  sanitizeBriefOutput,
  type BriefLlmRaw,
} from "./llm.ts";
import { BRIEF_NOW, seedBriefWorld } from "./testing.ts";

function chat(content: unknown, usage = { prompt_tokens: 1200, completion_tokens: 300 }) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage }), text: async () => "" } as Response;
}

const GOOD: BriefLlmRaw = {
  ringkasan: "Dua langkah BMS terlambat. Konektor XT90 menahan pengadaan. Fokus hari ini ke winch tether.",
  prioritas: [{ planRef: "3.07", alasan: "Jatuh tempo hari ini dan motor winch belum datang." }],
  hambatan: [{ planRef: "aerolift:6.02", masalah: "Konektor belum dikirim supplier", saran: "Bagas minta ETA tertulis ke supplier hari ini; bila belum ada, eskalasi ke tim Mechanical untuk konektor pengganti.", pic: "Bagas" }],
};

test("sanitize keeps what the facts back up and normalises the step ids", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);

  const out = sanitizeBriefOutput(GOOD, facts);

  assert.deepEqual(out.prioritas, [{ planRef: "aerolift:3.07", alasan: "Jatuh tempo hari ini dan motor winch belum datang." }]);
  assert.equal(out.hambatan[0]?.planRef, "aerolift:6.02");
  assert.equal(out.hambatan[0]?.pic, "Bagas");
  assert.match(out.ringkasan, /^Dua langkah BMS terlambat\./);
});

test("sanitize drops priorities and obstacles that cite a step the facts never mention", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);

  const out = sanitizeBriefOutput(
    {
      ringkasan: "",
      prioritas: [
        { planRef: "9.99", alasan: "Dikarang" },
        { planRef: "2.01", alasan: "Sudah selesai dan tidak disebut di fakta" },
        { planRef: "1.01", alasan: "Terlambat paling lama" },
        { planRef: "aerolift:1.01", alasan: "Duplikat" },
      ],
      hambatan: [
        { planRef: "8.88", masalah: "Tidak ada", saran: "Tidak ada" },
        { planRef: null, masalah: "Kunci panel hilang", saran: "Wisnu cek ke gudang" },
      ],
    },
    facts,
  );

  assert.deepEqual(out.prioritas.map((p) => p.planRef), ["aerolift:1.01"]);
  assert.deepEqual(out.hambatan.map((h) => h.masalah), ["Kunci panel hilang"]);
});

test("sanitize drops PIC names that are not members in the facts but keeps the item", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);

  const out = sanitizeBriefOutput(
    {
      ringkasan: "",
      prioritas: [],
      hambatan: [
        { planRef: "6.02", masalah: "a", saran: "b", pic: "Budi" },
        { planRef: "6.02", masalah: "c", saran: "d", pic: "gunawan dan Budi / Bagas" },
        { planRef: "6.02", masalah: "e", saran: "f", pic: null },
      ],
    },
    facts,
  );

  assert.deepEqual(out.hambatan.map((h) => h.pic), [undefined, "Gunawan, Bagas", undefined]);
  assert.equal(out.hambatan.length, 3);
});

test("sanitize trims long strings, caps list sizes and limits the summary to three sentences", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  const long = "kata ".repeat(200);

  const out = sanitizeBriefOutput(
    {
      ringkasan: `Satu. Dua. Tiga. Empat. ${long}`,
      prioritas: ["1.01", "1.02", "3.07", "3.08", "4.03", "6.02"].map((planRef) => ({ planRef, alasan: long })),
      hambatan: Array.from({ length: 8 }, () => ({ planRef: "6.02", masalah: long, saran: long })),
    },
    facts,
  );

  assert.equal(out.ringkasan, "Satu. Dua. Tiga.");
  assert.equal(out.prioritas.length, 3);
  assert.equal(out.hambatan.length, 4);
  for (const p of out.prioritas) assert.ok(p.alasan.length <= 220);
  for (const h of out.hambatan) assert.ok(h.saran.length <= 220 && h.masalah.length <= 160);

  const longSummary = sanitizeBriefOutput({ ringkasan: long, prioritas: [], hambatan: [] }, facts);
  assert.ok(longSummary.ringkasan.length <= 400);
});

test("the model is shown the facts, not phone numbers, and the system prompt never varies", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  const content = buildBriefUserContent(facts);

  assert.match(content, /aerolift:3\.07/);
  assert.match(content, /Konektor belum datang/);
  assert.doesNotMatch(content, /081234567890/);
  assert.ok(BRIEF_SYSTEM_PROMPT.split("\n").length <= 25);
});

test("requestBriefInsights makes one non-thinking call, validates it and records a scheduled_summary invocation", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  const bodies: Array<{ extra_body: unknown; messages: Array<{ role: string }> }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return chat(GOOD);
  }) as typeof fetch;

  const out = await requestBriefInsights(db, { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m" }, facts, BRIEF_NOW);

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]?.extra_body, { thinking: { type: "disabled" } });
  assert.equal(out?.prioritas[0]?.planRef, "aerolift:3.07");
  const rows = await db.select().from(llmInvocations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.feature, "scheduled_summary");
  assert.equal(rows[0]?.thinkingMode, false);
  assert.equal(rows[0]?.promptTokens, 1200);
  assert.equal(rows[0]?.failureReason, null);
});

test("requestBriefInsights records the failed call and rethrows", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  const fetchImpl = (async () => {
    throw new Error("gateway down");
  }) as unknown as typeof fetch;

  await assert.rejects(
    requestBriefInsights(db, { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m" }, facts, BRIEF_NOW),
    /gateway down/,
  );
  const rows = await db.select().from(llmInvocations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.feature, "scheduled_summary");
  assert.match(rows[0]?.failureReason ?? "", /gateway down/);
});

test("requestBriefInsights gives up at the timeout instead of holding the 08:00 message", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  const started = Date.now();
  await assert.rejects(requestBriefInsights(db, { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m", timeoutMs: 50 }, facts, BRIEF_NOW));
  assert.ok(Date.now() - started < 5000);
});

test("requestBriefInsights makes no call when there is nothing to summarise", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  const empty = { ...facts, plan: null, planChanges: [], flags: [], blockers: { reportingDay: null, fromReports: [], planBlocked: [], riskDueSoon: [] } };
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return chat(GOOD);
  }) as unknown as typeof fetch;

  const out = await requestBriefInsights(db, { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m" }, empty, BRIEF_NOW);

  assert.equal(out, null);
  assert.equal(calls, 0);
});
