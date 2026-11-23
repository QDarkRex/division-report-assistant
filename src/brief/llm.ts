import { z } from "zod";
import type { AppDatabase } from "../db/types.ts";
import { callLlmForJson, LlmCallError, type LlmClientConfig } from "../llm/client.ts";
import { getCurrentBudgetStatus, isLlmCallAllowed } from "../llm/budget.ts";
import { recordFailedInvocation, recordInvocation } from "../llm/cost.ts";
import { resolvePlanRef, type MorningBriefFacts } from "./facts.ts";

/**
 * The one LLM call in the morning brief: a short read of the facts, the few
 * steps that deserve attention today, and a concrete suggestion for each
 * blocker. The model never produces a number, a list of tasks or a date for
 * the message — render.ts prints those from the facts — and whatever it
 * returns is checked against the facts before anything uses it, so the worst
 * a bad answer can do is leave a section out.
 */

const MAX_RINGKASAN_CHARS = 400;
const MAX_RINGKASAN_SENTENCES = 3;
const MAX_ALASAN_CHARS = 220;
const MAX_MASALAH_CHARS = 160;
const MAX_SARAN_CHARS = 220;
const MAX_PRIORITAS = 3;
const MAX_HAMBATAN = 4;
/** A brief nobody can wait for is worse than one without suggestions. */
export const DEFAULT_BRIEF_LLM_TIMEOUT_MS = 90_000;

/** Lists longer than this are cut before they reach the model; the rendered message caps them lower still. */
const PAYLOAD_LIST_CAP = 20;

/**
 * Byte-stable (see LlmCallParams.systemPrompt): everything that varies per
 * morning goes in the user message.
 */
export const BRIEF_SYSTEM_PROMPT = `Kamu menyusun rangkuman pagi untuk grup WhatsApp divisi engineering. Kamu menerima FAKTA hari ini dalam JSON: progress plan proyek, task terlambat, hambatan dari laporan dan plan, perubahan plan, flag laporan, dan task tanpa laporan.

ATURAN KERAS
1. Gunakan HANYA fakta yang diberikan. Jangan mengarang task, orang, angka, tanggal, atau penyebab. Jika fakta kurang, tulis lebih sedikit; jangan menebak.
2. "planRef" harus persis salah satu planRef di fakta (contoh "aerolift:3.07"). "pic" harus persis nama yang ada di fakta.
3. Jangan mengulang angka atau daftar yang sudah ditampilkan sistem (jumlah, persentase progress, hari keterlambatan, daftar terlambat, daftar perubahan). Jangan menyebut ulang semua task terlambat.
4. Saran harus konkret dan bisa dikerjakan hari ini: siapa melakukan apa, apa yang perlu dibuka, dan ke siapa dieskalasi (mis. tim Mechanical atau pengadaan, hanya bila fakta menyebut kebutuhan itu). Hindari saran umum seperti "tingkatkan koordinasi".
5. Jangan mengarang dokumen, file, rapat, atau artefak yang tidak disebut di fakta (mis. checklist, laporan uji, notulen, form, tiket).
6. "ringkasan" tidak boleh mengulang persentase atau jumlah apa pun (sudah ditampilkan sistem di atasnya); cukup kondisi hari ini dan satu hal terpenting.
7. Utamakan hambatan dari plan (Aerolift) lebih dulu; hambatan di luar plan sesudahnya.
8. Satu kalimat per "saran".
9. Bahasa Indonesia santai namun profesional, singkat, tanpa emoji dan tanpa markdown.

KELUARAN: satu objek JSON saja, tanpa teks lain:
{"ringkasan": "maksimal 3 kalimat: kondisi hari ini dan satu hal terpenting",
 "prioritas": [{"planRef": "...", "alasan": "satu kalimat: kenapa ini yang pertama hari ini"}],
 "hambatan": [{"planRef": "... atau null bila bukan bagian plan", "masalah": "hambatannya, singkat", "saran": "langkah konkret", "pic": "nama dari fakta, atau hilangkan field ini"}]}
"prioritas" maksimal 3 dan "hambatan" maksimal 4, urut dari yang terpenting. Pakai array kosong bila tidak ada yang layak.`;

export const BriefLlmSchema = z.object({
  ringkasan: z.string().default(""),
  prioritas: z.array(z.object({ planRef: z.string(), alasan: z.string() })).default([]),
  hambatan: z
    .array(
      z.object({
        planRef: z.string().nullable().default(null),
        masalah: z.string(),
        saran: z.string(),
        pic: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export type BriefLlmRaw = z.infer<typeof BriefLlmSchema>;

/** The model's answer after validation against the facts. */
export interface BriefLlmOutput {
  ringkasan: string;
  prioritas: Array<{ planRef: string; alasan: string }>;
  hambatan: Array<{ planRef: string | null; masalah: string; saran: string; pic?: string }>;
}

// --- validation -----------------------------------------------------------------

function trimTo(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** At most `maxSentences` sentences and `maxChars` characters, cut at a sentence end when there is one. */
function limitSentences(text: string, maxSentences: number, maxChars: number): string {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];
  const kept: string[] = [];
  for (const sentence of sentences.slice(0, maxSentences)) {
    const candidate = [...kept, sentence.trim()].join(" ");
    if (candidate.length > maxChars && kept.length > 0) break;
    kept.push(sentence.trim());
  }
  return trimTo(kept.join(" "), maxChars);
}

/** The model may name a PIC as "Bagas", "Bagas / Gunawan" or "Bagas dan Gunawan"; only names present in the facts survive. */
function validPic(raw: string | null | undefined, memberNames: readonly string[]): string | undefined {
  if (!raw) return undefined;
  const byLower = new Map(memberNames.map((n) => [n.toLowerCase(), n]));
  const picked: string[] = [];
  for (const part of raw.split(/\s*(?:,|\/|&|\bdan\b|\+)\s*/i)) {
    const name = byLower.get(part.trim().toLowerCase());
    if (name && !picked.includes(name)) picked.push(name);
  }
  return picked.length > 0 ? picked.join(", ") : undefined;
}

/**
 * Drops everything the facts cannot back up: priorities and obstacles that
 * cite a step the facts never mention, and PIC names that are not people in
 * the facts. Strings are bounded; lists are capped. An obstacle with no plan
 * step (planRef null) is kept — a report can describe a problem that belongs
 * to no plan step — but one that cites an unknown step is dropped whole,
 * since its advice was written for something that is not there.
 */
export function sanitizeBriefOutput(raw: BriefLlmRaw, facts: MorningBriefFacts): BriefLlmOutput {
  const seen = new Set<string>();
  const prioritas: BriefLlmOutput["prioritas"] = [];
  for (const entry of raw.prioritas) {
    const planRef = resolvePlanRef(entry.planRef, facts);
    const alasan = trimTo(entry.alasan, MAX_ALASAN_CHARS);
    if (!planRef || alasan.length === 0 || seen.has(planRef)) continue;
    seen.add(planRef);
    prioritas.push({ planRef, alasan });
    if (prioritas.length >= MAX_PRIORITAS) break;
  }

  const hambatan: BriefLlmOutput["hambatan"] = [];
  for (const entry of raw.hambatan) {
    const cited = entry.planRef?.trim() ? entry.planRef : null;
    const planRef = cited === null ? null : resolvePlanRef(cited, facts);
    if (cited !== null && planRef === null) continue;
    const masalah = trimTo(entry.masalah, MAX_MASALAH_CHARS);
    const saran = trimTo(entry.saran, MAX_SARAN_CHARS);
    if (masalah.length === 0 || saran.length === 0) continue;
    const pic = validPic(entry.pic, facts.memberNames);
    hambatan.push({ planRef, masalah, saran, ...(pic ? { pic } : {}) });
    if (hambatan.length >= MAX_HAMBATAN) break;
  }

  return { ringkasan: limitSentences(raw.ringkasan, MAX_RINGKASAN_SENTENCES, MAX_RINGKASAN_CHARS), prioritas, hambatan };
}

// --- what the model is shown ------------------------------------------------------

/** Facts as the model sees them: lists bounded, the label index (render-only) and nothing else left out. */
export function buildBriefUserContent(facts: MorningBriefFacts): string {
  const cap = <T>(list: readonly T[]): T[] => list.slice(0, PAYLOAD_LIST_CAP);
  const { labels: _labels, ...plan } = facts.plan ?? { labels: {} };
  const payload = {
    tanggal: facts.today,
    plan: facts.plan
      ? { ...plan, overdue: cap(facts.plan.overdue), dueToday: cap(facts.plan.dueToday), dueTomorrow: cap(facts.plan.dueTomorrow), startingToday: cap(facts.plan.startingToday) }
      : null,
    perubahanPlanSejakKemarin: cap(facts.planChanges).map((g) => ({ planRef: g.planRef, perubahan: g.changes.map((c) => c.text) })),
    hambatan: {
      dariLaporan: cap(facts.blockers.fromReports),
      planBlocked: cap(facts.blockers.planBlocked),
      risikoMendekatiDeadline: cap(facts.blockers.riskDueSoon),
    },
    flagLaporan: cap(facts.flags),
    tanpaLaporan: cap(facts.quiet).map((q) => ({ planRef: q.planRef, title: q.title, pic: q.pic })),
    nonPlan: facts.general,
    namaAnggota: facts.memberNames,
  };
  return `FAKTA ${facts.today}:\n${JSON.stringify(payload)}`;
}

/** Nothing to summarise or advise on — skip the call rather than pay for a generic paragraph. */
export function hasBriefSubstance(facts: MorningBriefFacts): boolean {
  const b = facts.blockers;
  return (
    facts.plan !== null ||
    facts.planChanges.length > 0 ||
    b.fromReports.length > 0 ||
    b.planBlocked.length > 0 ||
    b.riskDueSoon.length > 0 ||
    facts.flags.length > 0
  );
}

// --- the call -------------------------------------------------------------------------

export interface BriefLlmDeps {
  llm: LlmClientConfig;
  model: string;
  /** Whole-call ceiling, retries included. */
  timeoutMs?: number;
}

/**
 * One non-thinking call, validated, recorded under "scheduled_summary" (the
 * feature the hard budget limit still allows). Returns null when the call is
 * not made (budget, nothing to say); THROWS when it was made and failed, after
 * recording what it cost — the caller decides to send the brief without it.
 */
export async function requestBriefInsights(
  db: AppDatabase,
  deps: BriefLlmDeps,
  facts: MorningBriefFacts,
  now: Date = new Date(),
): Promise<BriefLlmOutput | null> {
  if (!hasBriefSubstance(facts)) return null;
  const status = await getCurrentBudgetStatus(db, now);
  if (!isLlmCallAllowed(status, "scheduled_summary")) return null;

  const timeoutMs = deps.timeoutMs ?? DEFAULT_BRIEF_LLM_TIMEOUT_MS;
  const baseFetch = deps.llm.fetchImpl ?? fetch;
  // One signal for the whole call: a retry loop that keeps a stuck gateway
  // waiting past 08:00 would delay the group's morning message for nothing.
  const signal = AbortSignal.timeout(timeoutMs);
  const llm: LlmClientConfig = { ...deps.llm, fetchImpl: (input, init) => baseFetch(input, { ...init, signal }) };

  let result;
  try {
    result = await callLlmForJson(llm, {
      model: deps.model,
      systemPrompt: BRIEF_SYSTEM_PROMPT,
      userContent: buildBriefUserContent(facts),
      schema: BriefLlmSchema,
      thinkingMode: false,
      maxOutputTokens: 1600,
    });
  } catch (error) {
    const detail = error instanceof LlmCallError ? error.detail : null;
    await recordFailedInvocation(db, {
      feature: "scheduled_summary",
      model: deps.model,
      thinkingMode: false,
      promptTokens: detail?.promptTokens ?? 0,
      completionTokens: detail?.completionTokens ?? 0,
      retryCount: detail ? Math.max(detail.attempts - 1, 0) : 0,
      failureReason: detail?.lastFailureReason ?? (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }

  await recordInvocation(db, {
    feature: "scheduled_summary",
    model: deps.model,
    thinkingMode: false,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    retryCount: result.retryCount,
  });
  return sanitizeBriefOutput(result.data, facts);
}
