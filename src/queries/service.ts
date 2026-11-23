import type { AppDatabase } from "../db/types.ts";
import type { LlmClientConfig } from "../llm/client.ts";
import { callLlmForJson, LlmCallError } from "../llm/client.ts";
import { QueryIntentSchema, type QueryIntent } from "../llm/schemas.ts";
import { getCurrentBudgetStatus, isLlmCallAllowed } from "../llm/budget.ts";
import { recordFailedInvocation, recordInvocation } from "../llm/cost.ts";
import { executeQuery } from "./executors.ts";
import {
  clearPendingConfirmation,
  describeIntent,
  getPendingConfirmation,
  isMutatingIntent,
  parseConfirmationReply,
  setPendingConfirmation,
} from "./confirmation.ts";
import { formatQueryResult } from "./format.ts";
import { applyReportMatchReply, REPORT_MATCH_HELP } from "../plan/report-match.ts";
import { parseReportMatchReply } from "../plan/report-match-reply.ts";
import { joinBlocks, titleLine } from "../format/wa.ts";
import { classifyOvertimeIntent } from "./overtime-intent.ts";

/**
 * Byte-stable across calls, same cache-hit rationale as the report
 * extraction prompt (ADR-0010 addendum).
 */
const QUERY_INTENT_SYSTEM_PROMPT = `Anda mengekstrak maksud (intent) dan parameter dari pertanyaan anggota divisi listrik kepada bot helper. Anda TIDAK menjawab pertanyaannya — hanya mengekstrak struktur, backend yang akan mengeksekusi query database sungguhan.

Pilih salah satu intent:
- tasks_today: tugas/task yang jatuh tempo hari ini
- nearest_deadline: deadline terdekat, task mana yang paling mendesak
- member_tasks: task yang sedang dikerjakan seseorang (isi targetMemberName; isi dayOffset HANYA kalau pertanyaannya menyebut hari tertentu, mis. "tugas Nisa besok apa")
- missing_reporters: siapa yang belum lapor hari ini
- task_status: status/update terakhir satu task tertentu (isi taskReference)
- member_report: isi laporan seseorang pada hari tertentu (isi targetMemberName, dayOffset)
- stale_tasks: task yang stale (tidak ada update lama)
- project_summary: rangkuman satu project (isi projectReference)
- overtime_today: PERTANYAAN/permintaan melihat daftar siapa yang lembur ("siapa yang lembur hari ini?", "siapa aja yg lembur", "yang lembur siapa", "lihat daftar lembur", "daftar yang lembur", "rekap lembur", "lembur?") — hanya menanyakan, tidak menandai siapa pun
- overtime_checkin: si PENGIRIM sendiri menyatakan mulai/absen/mengajukan lembur — HANYA deklarasi orang pertama, BUKAN pertanyaan; isi timeText dengan jam mulai kalau disebut, apa adanya. Contoh nyata: "lembur", "absen lembur", "mengajukan lembur", "ngejukan lembur", "izin pengajuan lembur", "saya lembur", "ikut lembur", "mulai lembur jam 5". ATURAN: kata "lembur" SENDIRIAN (tanpa tanda tanya dan tanpa kata tanya) adalah overtime_checkin, BUKAN overtime_today
- overtime_checkout: si PENGIRIM sendiri menyatakan selesai lembur ("saya selesai lembur", "stop lembur jam 9") — deklarasi orang pertama, BUKAN pertanyaan; isi timeText dengan jam selesai kalau disebut, apa adanya
- create_task: admin menugaskan pekerjaan ke satu atau beberapa orang ("tugaskan Nisa dan Udin besok ke lokasi B mengerjakan centering docking", "buat task cek panel untuk Budi") — isi taskTitle dengan pekerjaannya saja tanpa nama dan tanpa hari; isi targetMemberNames dengan SEMUA nama yang disebut; isi dayOffset kalau harinya disebut (besok = 1), kosongkan kalau tidak disebut; isi projectReference kalau ada nama project
- export_daily_report: minta laporan satu hari dikirim sebagai file Excel/xlsx supaya bisa diteruskan ke luar divisi ("kirim report hari ini", "export laporan kemarin ke excel", "tolong kirim laporan tanggal 8 buat Sena") (isi dayOffset; hari ini = 0)
- set_availability: anggota menyatakan izin/cuti/sakit/telat/pulang cepat (isi availabilityKind: "izin", "cuti", "sakit", "telat" untuk datang telat, atau "pulang_cepat" untuk pulang lebih awal; isi dayOffset; isi targetMemberName HANYA jika mendeklarasikan untuk orang lain, bukan diri sendiri; isi availabilityReason dengan alasan/jam apa adanya jika disebutkan, mis. "bimbingan skripsi", "diare", atau untuk telat/pulang cepat jamnya seperti "datang jam 10" / "pulang jam 2", kosongkan jika tidak disebutkan)
- cancel_availability: membatalkan/mengoreksi catatan izin/cuti/sakit yang sudah terlanjur dicatat ("batalkan izin saya hari ini", "saya jadi masuk kok") (isi dayOffset; isi targetMemberName HANYA jika untuk orang lain)
- unknown: jika tidak cocok dengan kategori manapun

dayOffset adalah angka: 0 = hari ini, -1 = kemarin, 1 = besok, dst. JANGAN PERNAH menulis tanggal literal, hanya angka offset.

Jika pesan menyebut beberapa hari sekaligus, SEMUANYA harus ikut terisi — jangan ambil satu saja:
- Hari yang disebut relatif ("besok", "hari ini", "lusa") masuk ke dayOffset.
- Tanggal yang disebut sebagai angka ("tanggal 12", "tanggal 12,19,26") masuk ke additionalDayOfMonths sebagai daftar angka apa adanya: [12,19,26]. JANGAN dihitung jadi offset, JANGAN ditebak bulannya — backend yang menentukan tanggalnya.
Contoh: "Besok izin gak masuk, begitu juga di tanggal 12,19,26 mendatang" -> dayOffset 1, additionalDayOfMonths [12,19,26].

Aturan penting: kalau pesannya berbentuk PERTANYAAN (mengandung "siapa", "apakah", tanda tanya, dll), pilih intent yang hanya membaca (overtime_today, member_tasks, dst) — JANGAN PERNAH memilih intent yang menandai/mengubah (overtime_checkin, overtime_checkout, set_availability, create_task). Menandai orang karena salah membaca pertanyaan adalah kesalahan yang harus dihindari.

Balas HANYA dengan satu objek JSON valid. Tidak ada teks lain, tidak ada markdown.`;

const RATE_LIMIT_PER_MEMBER_PER_HOUR = 10;
const RATE_LIMIT_GLOBAL_PER_HOUR = 60;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** In-process only — a restart resetting this costs pennies at this data volume, not worth persisting. */
const memberCallTimestamps = new Map<string, number[]>();
let globalCallTimestamps: number[] = [];

function pruneOld(timestamps: number[], now: number): number[] {
  return timestamps.filter((t) => now - t < ONE_HOUR_MS);
}

function isRateLimited(memberId: string, now: number): boolean {
  const memberTimes = pruneOld(memberCallTimestamps.get(memberId) ?? [], now);
  globalCallTimestamps = pruneOld(globalCallTimestamps, now);
  return memberTimes.length >= RATE_LIMIT_PER_MEMBER_PER_HOUR || globalCallTimestamps.length >= RATE_LIMIT_GLOBAL_PER_HOUR;
}

function recordCall(memberId: string, now: number): void {
  const memberTimes = memberCallTimestamps.get(memberId) ?? [];
  memberTimes.push(now);
  memberCallTimestamps.set(memberId, memberTimes);
  globalCallTimestamps.push(now);
}

/**
 * Answers one @helper query end to end: rate limit -> budget gate -> LLM
 * intent parse -> deterministic execution -> deterministic formatting.
 * Queries are the lower-priority LLM consumer relative to report
 * ingestion (MASTER_SPEC.md §4.4) — at hard budget limit, queries are
 * refused with no LLM call at all, while report extraction keeps working.
 */
/**
 * A query answer is text, and occasionally a file as well: export_daily_report
 * produces an .xlsx the caller has to actually send. Returning it here rather
 * than sending from inside the executor keeps the "LLM never mutates, never
 * sends" boundary intact — executors read and format, the caller delivers.
 */
/** Which path decided the intent, for the logs: the deterministic overtime pre-classifier, the LLM, or a confirmed parked intent. */
export type IntentSource = "pre_classifier" | "llm" | "confirmation";

export interface QueryAnswer {
  text: string;
  intentSource?: IntentSource;
  attachment?: { content: Buffer; fileName: string; mimeType: string };
}

export async function answerQuery(
  db: AppDatabase,
  llm: LlmClientConfig,
  memberId: string,
  queryText: string,
  now: Date = new Date(),
  model = "deepseek-v4-flash",
): Promise<QueryAnswer> {
  // Runs a fully-decided intent and shapes its reply. Shared by the
  // confirmation path (a parked mutation the member just approved) and the
  // read-only path (a query that never needed confirming).
  const runIntent = async (intent: QueryIntent, intentSource: IntentSource, executeAt: Date = now): Promise<QueryAnswer> => {
    const queryResult = await executeQuery(db, intent, executeAt, memberId);
    const text = formatQueryResult(queryResult, now);
    if (queryResult.kind === "daily_report_export") {
      return {
        text,
        attachment: {
          content: queryResult.content,
          fileName: queryResult.fileName,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        intentSource,
      };
    }
    return { text, intentSource };
  };

  // A mutating intent is proposed, not run: park it and ask. Only an
  // explicit "ya" (handled below on the next message) will execute it. A
  // read-only intent runs straight away. Shared by the LLM and the
  // pre-classifier so both obey the same confirmation rule.
  const proposeOrRun = async (intent: QueryIntent, intentSource: IntentSource): Promise<QueryAnswer> => {
    if (isMutatingIntent(intent)) {
      await setPendingConfirmation(db, memberId, intent, now);
      return {
        text: joinBlocks(titleLine("❓", "Konfirmasi"), `${describeIntent(intent)}?`, "Balas *@helper ya* untuk lanjut, atau *@helper batal*."),
        intentSource,
      };
    }
    return runIntent(intent, intentSource);
  };

  // A reply to the numbered plan-match list ("ya", "2 ya 3 bukan", "3 = 2.08")
  // is handled before anything else, deterministically — no LLM call, no
  // rate-limit budget. A message that is not built from reply vocabulary at
  // all ("tugas Nisa besok apa") falls through to the normal paths below.
  const pending = await getPendingConfirmation(db, memberId, now);
  if (pending?.kind === "report_match") {
    const matchReply = parseReportMatchReply(queryText);
    if (matchReply?.kind === "invalid") return { text: REPORT_MATCH_HELP };
    if (matchReply) return { text: await applyReportMatchReply(db, memberId, pending.match, matchReply, now) };
  }

  // A confirmation reply is handled before anything else — deterministically,
  // spending no LLM call and no rate-limit budget. "@helper ya" runs the
  // parked mutation; "@helper batal" drops it. This is the whole point of
  // the two-step: the confirming word is matched by code, never by the model
  // that may have misread the original request.
  const reply = parseConfirmationReply(queryText);
  if (reply !== null) {
    if (reply === "cancel") {
      if (pending) await clearPendingConfirmation(db, memberId);
      return { text: pending ? "Oke, dibatalkan." : "Tidak ada yang perlu dibatalkan." };
    }
    if (!pending) return { text: "Tidak ada yang perlu dikonfirmasi." };
    await clearPendingConfirmation(db, memberId);
    if (pending.kind === "query") {
      // Overtime is dated by when the member ASKED, not when they said "ya":
      // a check-in proposed at 09:59 and confirmed at 10:01 is still the
      // morning's check-in. (pending.createdAt is the time of the original message.)
      const isOvertime = pending.intent.intent === "overtime_checkin" || pending.intent.intent === "overtime_checkout";
      return runIntent(pending.intent, "confirmation", isOvertime ? pending.createdAt : now);
    }
  }

  // Obvious overtime phrasings are decided by code, before the model (and
  // before the rate limit and budget gates — it costs nothing). The result
  // takes exactly the path an LLM intent would: a check-in/checkout is still
  // proposed and needs a "ya". Anything unusual returns null and falls
  // through to the LLM.
  const pre = classifyOvertimeIntent(queryText);
  if (pre) {
    const intent: QueryIntent = { intent: pre.intent, ...(pre.timeText ? { timeText: pre.timeText } : {}) };
    return proposeOrRun(intent, "pre_classifier");
  }

  if (isRateLimited(memberId, now.getTime())) {
    return { text: "Terlalu banyak pertanyaan dalam satu jam terakhir, coba lagi nanti." };
  }

  const budgetStatus = await getCurrentBudgetStatus(db, now);
  if (!isLlmCallAllowed(budgetStatus, "query_intent")) {
    return { text: "Kuota AI bulan ini sudah habis, query belum bisa dijawab — coba lagi bulan depan. Laporan tetap diproses seperti biasa." };
  }

  recordCall(memberId, now.getTime());

  // Same failure mode already fixed once for report extraction
  // (pipeline.ts, 2026-08-08): an LLM call that exhausts repair attempts
  // must never propagate as an uncaught throw — that's silence, not an
  // answer. Return a plain-language failure instead of crashing the
  // caller or leaving the member with no reply at all.
  let result;
  try {
    result = await callLlmForJson(llm, {
      model,
      systemPrompt: QUERY_INTENT_SYSTEM_PROMPT,
      userContent: queryText,
      schema: QueryIntentSchema,
      thinkingMode: false,
    });
  } catch (error) {
    // Same blindness fix as pipeline.ts's report path (2026-08-10): an
    // empty catch here meant a member seeing "gangguan teknis" left no
    // trace at all — llm_invocations had literally zero query_intent rows
    // whether queries were never asked or always failing, which are very
    // different problems with the same (absent) evidence.
    const detail = error instanceof LlmCallError ? error.detail : null;
    await recordFailedInvocation(db, {
      feature: "query_intent",
      model,
      thinkingMode: false,
      promptTokens: detail?.promptTokens ?? 0,
      completionTokens: detail?.completionTokens ?? 0,
      retryCount: detail ? Math.max(detail.attempts - 1, 0) : 0,
      failureReason: detail?.lastFailureReason ?? (error instanceof Error ? error.message : String(error)),
    });
    return { text: "Maaf, gagal memproses pertanyaan itu karena gangguan teknis. Coba tanyakan lagi." };
  }

  await recordInvocation(db, {
    feature: "query_intent",
    model,
    thinkingMode: false,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    retryCount: result.retryCount,
  });

  return proposeOrRun(result.data, "llm");
}
