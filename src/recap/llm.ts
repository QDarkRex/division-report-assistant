import { z } from "zod";
import type { AppDatabase } from "../db/types.ts";
import { callLlmForJson, LlmCallError, type LlmClientConfig } from "../llm/client.ts";
import { getCurrentBudgetStatus, isLlmCallAllowed } from "../llm/budget.ts";
import { recordFailedInvocation, recordInvocation } from "../llm/cost.ts";
import type { BriefLlmDeps } from "../brief/llm.ts";
import { FALLBACK_STREAM_ID, type WeeklyRecapFacts } from "./facts.ts";

/**
 * The one LLM call of the weekly recap (ADR-0016): it assigns every item to a
 * work stream and writes the bullets and the "perlu perhatian" lines, each with
 * evidence aliases. It never writes a number, a weekday or a date — render.ts
 * does — and sanitizeRecapOutput() throws away whatever the facts cannot back.
 * The prompt is the bake-off winner (91% fully supported, 0 fabricated) plus
 * the fixes from the verifier's error list (day labels, overstated status,
 * resolved issues still listed as open).
 */

export const MAX_BULLET_CHARS = 160;
const MAX_PERHATIAN = 12;
const MAX_SHORT_NAME = 28;

export const PERHATIAN_KINDS = ["insiden", "komponen", "tertahan", "lain"] as const;
export type PerhatianKind = (typeof PERHATIAN_KINDS)[number];

/** Byte-stable (see LlmCallParams.systemPrompt): everything that varies per week goes in the user message. */
export const RECAP_SYSTEM_PROMPT = `Kamu adalah perangkum laporan kerja. Tugasmu: merangkum satu pekan butir laporan harian sebuah divisi Electrical Engineering menjadi rekap per work stream, dalam Bahasa Indonesia yang ringkas dan teknis.

INPUT (pesan user, JSON):
- registry: daftar work stream [{id, name, description}].
- items: butir laporan pekan ini, urut menurut hari [{id, day, member, kind, activity, result, obstacle, status}]. "id" adalah id bukti (contoh "i12"); "day" hanya untuk urutan dan menilai mana yang lebih baru.

ATURAN:
1. Gunakan HANYA data pada items. Dilarang mengarang angka, nama orang, hasil, penyebab, atau tanggal. Jika suatu hal tidak tertulis di items, jangan ditulis.
2. Setiap item ditempatkan ke TEPAT SATU stream memakai id dari registry. Boleh mengusulkan stream baru hanya jika tidak ada stream registry yang cocok; id stream baru wajib berawalan "new-" (contoh "new-solar-charger") dan isi "name" (nama jelas) serta "shortName" (maksimal 28 karakter) pada entri streams.
3. Tiap bullet wajib mencantumkan id bukti (field "evidence"): hanya item yang benar-benar mendukung kalimat itu, dan hanya item yang kamu tempatkan di stream tersebut. Hari dihitung kode dari id bukti, jadi jangan menyebut item yang tidak mendukung kalimat.
4. Pertahankan istilah teknis, tipe komponen, dan nomor part persis seperti tertulis (mis. BQ76952, INA219, W5500, ISO1050). Hanya perbaiki salah ketik jelas pada nama diri (mis. Alhpa menjadi Alpha).
5. Jumlah bullet mengikuti jumlah item yang kamu tempatkan di stream itu: 20 item atau lebih = 2-3 bullet; 8-19 item = 1-2 bullet; kurang dari 8 = 1 bullet. Tiap bullet maksimal 160 karakter, urut kronologis, dan memuat SATU pekerjaan/hasil yang konkret: jangan menggabungkan pekerjaan yang tidak berkaitan ke satu kalimat. Gabungkan hanya butir yang kembar. Hanya tulis stream yang punya butir.
6. DILARANG menulis nama hari (Senin, Sen, Selasa, dst.), tanggal, atau kata waktu relatif (kemarin, tadi) di bullet maupun perhatian. Kode menambahkan label hari dari bukti.
7. Kata "selesai", "berhasil", "lolos", "100%" hanya boleh bila item yang dikutip berstatus done atau hasilnya (result) menyatakannya. Selain itu pakai "dikerjakan", "berjalan", "dilanjutkan", "diuji".
8. Sebelum menulis suatu masalah (bullet maupun perhatian), periksa item yang lebih baru (day lebih akhir) di stream yang sama. Jika salah satunya menyatakan masalah itu sudah diperbaiki, normal, berhasil, selesai, atau diganti, JANGAN tulis sebagai masih terbuka: hilangkan dari perhatian, atau tulis "teratasi" di bullet.
9. "perhatian" berisi hal yang butuh perhatian pimpinan dan didukung item: insiden/kerusakan, komponen yang belum ada, hambatan atau status blocked, atau masalah yang belum selesai. Tiap entri maksimal 160 karakter, wajib punya evidence, dan punya "kind": "insiden" (keselamatan/kerusakan: asap, korsleting, jatuh, rusak), "komponen" (komponen/material belum ada), "tertahan" (hambatan atau status blocked), atau "lain". Boleh kosong.
10. Jangan menulis nama orang kecuali perlu untuk memahami bullet.

OUTPUT: hanya satu objek JSON valid (tanpa teks lain, tanpa markdown) dengan skema:
{"assignments":[{"itemId":"i1","streamId":"adm-box-truck"}],
 "streams":[{"streamId":"adm-box-truck","name":"(hanya untuk stream new-)","shortName":"(hanya untuk stream new-)","bullets":[{"text":"...","evidence":["i1","i2"]}]}],
 "perhatian":[{"text":"...","kind":"insiden","evidence":["i3"]}]}
"assignments" harus memuat SEMUA item (tepat satu entri per item).`;

export const RecapLlmSchema = z.object({
  assignments: z.array(z.object({ itemId: z.string(), streamId: z.string() })).default([]),
  streams: z
    .array(
      z.object({
        streamId: z.string(),
        name: z.string().optional(),
        shortName: z.string().optional(),
        bullets: z.array(z.object({ text: z.string(), evidence: z.array(z.string()).default([]) })).default([]),
      }),
    )
    .default([]),
  perhatian: z.array(z.object({ text: z.string(), kind: z.string().default("lain"), evidence: z.array(z.string()).default([]) })).default([]),
});
export type RecapLlmRaw = z.infer<typeof RecapLlmSchema>;

export interface RecapBullet {
  text: string;
  /** Item aliases that passed validation. */
  evidence: string[];
}

export interface RecapPlan {
  /** alias -> stream id, for EVERY item of the week. */
  assignment: Map<string, string>;
  /** Streams proposed by the model (or the fallback stream) that at least one item was assigned to. */
  newStreams: Array<{ streamId: string; name: string; shortName: string }>;
  bullets: Map<string, RecapBullet[]>;
  perhatian: Array<{ text: string; kind: PerhatianKind; evidence: string[] }>;
}

// --- validation -------------------------------------------------------------------

/** At most `max` characters including the "…"; cut at a word boundary, never mid-word (a single endless word is cut hard). */
export function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–-]+$/, "")}…`;
}

// --- inline aliases, ";" joins, resolved problems -------------------------------------------

/** "(i2, i3)", "(bukti: i2 dan i3)" or a bare "i2, i3": what the model sometimes writes into the text itself. */
const INLINE_ALIASES = /\(\s*(?:bukti\s*:?\s*)?i\d+(?:\s*(?:[,/&]|\bdan\b)\s*i\d+)*\s*\)|\bi\d+(?:\s*[,/&]\s*i\d+)*\b/gi;

/** Alias tokens removed, leftovers like "()" and doubled or dangling punctuation tidied. */
export function stripInlineAliases(text: string): string {
  return text
    .replace(INLINE_ALIASES, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+([,;.:)])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, "")
    .trim();
}

const MIN_PIECE_CHARS = 15;
const MAX_CLAUSE_CHARS = 40;

/**
 * One model "bullet" may be several pieces joined by ";" or " | ", each with its own inline aliases.
 * Every piece becomes a candidate of its own, with the evidence it cited itself (valid aliases only),
 * else the bullet's evidence. Leading weekday/date tokens go; pieces under 15 characters are dropped.
 */
function splitPieces(text: string, fallbackEvidence: string[], isValid: (alias: string) => boolean): RecapBullet[] {
  const pieces: RecapBullet[] = [];
  for (const raw of text.split(/\s*;\s*|\s+\|\s+/)) {
    const cited = [...new Set((raw.match(/\bi\d+\b/gi) ?? []).map((a) => a.toLowerCase()))].filter(isValid);
    const clean = clip(stripLeadingDay(stripInlineAliases(raw)), MAX_BULLET_CHARS - 2);
    const evidence = cited.length > 0 ? cited : fallbackEvidence;
    if (clean.length < MIN_PIECE_CHARS || evidence.length === 0) continue;
    // A short piece with no aliases of its own is a dependent clause ("; penyebab belum diketahui"): it rejoins the previous piece.
    const previous = pieces[pieces.length - 1];
    if (previous && cited.length === 0 && clean.length < MAX_CLAUSE_CHARS) {
      previous.text = clip(`${previous.text}, ${clean}`, MAX_BULLET_CHARS - 2);
      continue;
    }
    pieces.push({ text: clean, evidence });
  }
  return pieces;
}

/** A line that says the problem was fixed is a closed problem. Negated forms ("belum teratasi") are not resolutions. */
const RESOLVED =
  /sudah\s+(?:dipasang|diganti|diperbaiki|normal|berhasil|teratasi|selesai)|kini\s+stabil|sudah\s+stabil|(?<!belum\s)(?<!tidak\s)teratasi|berhasil\s+(?:di)?(?:atasi|perbaiki)/i;

const WD = "(?:senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|sen|sel|rab|kam|jum|sab|min)";
const DATE = "\\d{1,2}(?:\\s*(?:[–-]|s/d)\\s*\\d{1,2})?\\s+(?:jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)[a-z]*(?:\\s+\\d{4})?";
const TOKEN = `(?:${WD}\\b|${DATE})`;
const LEADING_DAY = new RegExp(`^\\s*${TOKEN}(?:\\s*(?:[–\\-,/&]|\\bdan\\b|s/d)?\\s*${TOKEN})*\\s*[:,–-]\\s*`, "i");

/** The model is told never to write days; whatever slips through at the start of a line is removed (the label comes from the evidence). */
export function stripLeadingDay(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEADING_DAY, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

function slugOf(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

function humanize(slug: string): string {
  const words = slug.replace(/^new-/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function kindOf(raw: string): PerhatianKind {
  const k = raw.trim().toLowerCase();
  return (PERHATIAN_KINDS as readonly string[]).includes(k) ? (k as PerhatianKind) : "lain";
}

/**
 * Drops everything the facts cannot back up:
 *  - evidence aliases that are not items of this week, and bullets/perhatian left without evidence;
 *  - bullet evidence that the model placed in another stream (the day label is computed from it);
 *  - leading weekday/date tokens, over-long text;
 *  - stream ids that are neither in the registry nor "new-...": the item goes to "lain-lain".
 * Items the model forgot keep their earlier assignment or fall to "lain-lain".
 */
export function sanitizeRecapOutput(raw: RecapLlmRaw, facts: WeeklyRecapFacts): RecapPlan {
  const aliases = new Set(facts.items.map((i) => i.alias));
  const registry = new Set(facts.registry.map((s) => s.streamId));
  const declared = new Map(raw.streams.map((s) => [s.streamId, s]));

  const resolveStream = (id: string): string => {
    const trimmed = id.trim();
    if (registry.has(trimmed)) return trimmed;
    if (trimmed.startsWith("new-")) {
      const slug = slugOf(trimmed);
      if (slug.length > 4) return slug;
    }
    return FALLBACK_STREAM_ID;
  };

  const assignment = new Map<string, string>();
  for (const a of raw.assignments) {
    if (!aliases.has(a.itemId) || assignment.has(a.itemId)) continue;
    assignment.set(a.itemId, resolveStream(a.streamId));
  }
  for (const item of facts.items) {
    if (!assignment.has(item.alias)) assignment.set(item.alias, item.workStreamId && registry.has(item.workStreamId) ? item.workStreamId : FALLBACK_STREAM_ID);
  }

  const used = new Set(assignment.values());
  const newStreams: RecapPlan["newStreams"] = [];
  for (const id of used) {
    if (registry.has(id)) continue;
    if (id === FALLBACK_STREAM_ID) {
      newStreams.push({ streamId: id, name: "Lain-lain / Dukungan Umum", shortName: "Lain-lain" });
      continue;
    }
    // The model may declare the stream under its raw id; match by slug.
    const decl = [...declared.entries()].find(([k]) => slugOf(k) === id)?.[1];
    const name = clip(stripInlineAliases(decl?.name ?? "") || humanize(id), 120);
    newStreams.push({ streamId: id, name, shortName: clip(stripInlineAliases(decl?.shortName ?? "") || name, MAX_SHORT_NAME) });
  }

  const dayOf = new Map(facts.items.map((i) => [i.alias, i.day]));
  const countOf = new Map<string, number>();
  for (const id of assignment.values()) countOf.set(id, (countOf.get(id) ?? 0) + 1);

  const bullets = new Map<string, RecapBullet[]>();
  for (const s of raw.streams) {
    const id = resolveStream(s.streamId);
    if (!used.has(id)) continue;
    const candidates = bullets.get(id) ?? [];
    for (const b of s.bullets) {
      const own = [...new Set(b.evidence)].filter((e) => aliases.has(e) && assignment.get(e) === id);
      for (const piece of splitPieces(b.text, own, (e) => aliases.has(e) && assignment.get(e) === id)) {
        if (!candidates.some((c) => c.text === piece.text)) candidates.push(piece);
      }
    }
    if (candidates.length > 0) bullets.set(id, candidates);
  }
  // The budget follows the final item count, whatever the model wrote: the strongest pieces
  // (most evidence) survive, then they are put in order of their earliest evidence day.
  for (const [id, candidates] of bullets) {
    const n = countOf.get(id) ?? 0;
    const budget = n >= 20 ? 3 : n >= 8 ? 2 : 1;
    const firstDay = (b: RecapBullet) => b.evidence.map((e) => dayOf.get(e)!).sort()[0]!;
    const chosen = candidates
      .map((b, order) => ({ b, order }))
      .sort((x, y) => y.b.evidence.length - x.b.evidence.length || x.order - y.order)
      .slice(0, budget)
      .sort((x, y) => firstDay(x.b).localeCompare(firstDay(y.b)) || x.order - y.order)
      .map(({ b }) => b);
    bullets.set(id, chosen);
  }

  const perhatian: RecapPlan["perhatian"] = [];
  for (const p of raw.perhatian) {
    // shortcut: a regex cannot read meaning; it only catches the phrasings seen so far. Extend RESOLVED when a new one shows up.
    if (RESOLVED.test(p.text)) continue; // the line states its own resolution, so the problem is closed within the week
    const own = [...new Set(p.evidence)].filter((e) => aliases.has(e));
    for (const piece of splitPieces(p.text, own, (e) => aliases.has(e))) {
      perhatian.push({ ...piece, kind: kindOf(p.kind) });
    }
    if (perhatian.length >= MAX_PERHATIAN) break;
  }
  perhatian.length = Math.min(perhatian.length, MAX_PERHATIAN);

  return { assignment, newStreams, bullets, perhatian };
}

// --- what the model is shown -----------------------------------------------------------

/** Repeated in the user message so the guidance sits next to the data it applies to. */
export const BULLET_GUIDANCE =
  "Hitung item yang kamu tempatkan di tiap stream: >= 20 item = 2-3 bullet; 8-19 item = 1-2 bullet; < 8 item = 1 bullet. Satu bullet = satu pekerjaan/hasil konkret, jangan digabung. Masalah yang sudah diperbaiki oleh item yang lebih baru jangan ditulis terbuka.";

export function buildRecapUserContent(facts: WeeklyRecapFacts): string {
  const payload = {
    panduanBullet: BULLET_GUIDANCE,
    registry: facts.registry.map((s) => ({
      id: s.streamId,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      ...(facts.prevActivity[s.streamId]?.prevCount ? { butirPekanLalu: facts.prevActivity[s.streamId]!.prevCount } : {}),
    })),
    items: facts.items.map((i) => ({
      id: i.alias,
      day: i.day,
      member: i.member,
      ...(i.kind === "overtime" ? { kind: "lembur" } : {}),
      activity: i.activity,
      ...(i.result ? { result: i.result } : {}),
      ...(i.obstacle ? { obstacle: i.obstacle } : {}),
      status: i.status,
    })),
  };
  return JSON.stringify(payload);
}

// --- the call -------------------------------------------------------------------------------

/** One call for a whole week (~50 KB of items); the Sunday evening job can afford to wait. */
export const DEFAULT_RECAP_LLM_TIMEOUT_MS = 240_000;

/**
 * One non-thinking call, validated, recorded under "scheduled_summary".
 * THROWS when the call is not allowed or failed (after recording what it
 * cost); the caller then sends the deterministic fallback.
 */
export async function requestRecapPlan(db: AppDatabase, deps: BriefLlmDeps, facts: WeeklyRecapFacts, now: Date = new Date()): Promise<RecapPlan> {
  const status = await getCurrentBudgetStatus(db, now);
  if (!isLlmCallAllowed(status, "scheduled_summary")) throw new Error("LLM budget limit reached");

  const timeoutMs = deps.timeoutMs ?? DEFAULT_RECAP_LLM_TIMEOUT_MS;
  const baseFetch = deps.llm.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  const llm: LlmClientConfig = { ...deps.llm, fetchImpl: (input, init) => baseFetch(input, { ...init, signal }) };

  let result;
  try {
    result = await callLlmForJson(llm, {
      model: deps.model,
      systemPrompt: RECAP_SYSTEM_PROMPT,
      userContent: buildRecapUserContent(facts),
      schema: RecapLlmSchema,
      thinkingMode: false,
      maxOutputTokens: 9000,
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
  return sanitizeRecapOutput(result.data, facts);
}
