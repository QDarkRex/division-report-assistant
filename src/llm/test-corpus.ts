import type { MessageClassification } from "./schemas.ts";

/**
 * IMPLEMENTATION_ROADMAP.md Phase 2 exit criteria calls for "100+ test
 * messages classified correctly." This corpus is a deliberately honest
 * starting set (not padded to hit a round number with repetitive filler)
 * covering every classification category and the report-status edge cases
 * ACCEPTANCE_TESTS.md §2.2 calls out by name. Expand it as real group
 * messages surface edge cases — see the README's Phase 2 status.
 *
 * Not yet wired to a live-DeepSeek integration test (no API key available
 * in this session) — see llm/test-corpus.test.ts for what IS verified now
 * (corpus structural validity) versus what's deferred.
 */
export interface CorpusMessage {
  text: string;
  expectedCategory: MessageClassification["category"];
  note?: string;
}

export const REPORT_MESSAGES: CorpusMessage[] = [
  { text: "report\n- pekerjaan: cek panel B, hasil: aman, kendala: tidak ada", expectedCategory: "daily_report" },
  { text: "report Agas\n- ganti MCB di gardu induk 3, sudah selesai", expectedCategory: "daily_report" },
  { text: "daily report\n- pasang kabel NYY di panel C, masih berjalan", expectedCategory: "daily_report" },
  {
    text: "report\n- test docking charge, hasilnya charging berhasil tapi masih perlu dicek ulang besok",
    expectedCategory: "daily_report",
    note: "ACCEPTANCE_TESTS §2.2: 'test docking charge' must classify as testing, not done",
  },
  { text: "report\n- uji coba trafo baru di gardu 5, masih tahap testing", expectedCategory: "daily_report" },
  {
    text: "report\n- ganti sekring panel A, sudah selesai dan final, sudah dicek ulang",
    expectedCategory: "daily_report",
    note: "explicit 'selesai dan final' should classify as done",
  },
  { text: "report\n- cek instalasi kabel di lantai 2, terkendala akses ruangan terkunci", expectedCategory: "daily_report" },
  { text: "report Budi\n- survey lokasi pemasangan panel baru", expectedCategory: "daily_report" },
  { text: "report\n- Tidak ada aktivitas hari ini, izin sakit", expectedCategory: "daily_report", note: "no-activity report" },
  { text: "report\n- lanjut kerjaan kemarin, ganti trafo gardu 5, masih proses", expectedCategory: "daily_report" },
  { text: "report\n- pengecekan rutin panel utama, hasil aman semua", expectedCategory: "daily_report" },
  { text: "report Agas\n- perbaikan kabel putus di jalur B, sudah tersambung ulang, sudah dites dan berfungsi normal", expectedCategory: "daily_report" },
  {
    text: "report\n- pasang MCB baru di panel D, hasil uji coba OK tapi belum final karena nunggu approval",
    expectedCategory: "daily_report",
    note: "ambiguous completion — result positive but status should stay testing/in_progress, not done",
  },
  { text: "daily report\n- ganti kabel grounding di gardu 2, terkendala hujan jadi ditunda", expectedCategory: "daily_report" },
  { text: "report\n- cek beban trafo utama, over kapasitas, perlu tindakan lanjut", expectedCategory: "daily_report" },
];

export const QUERY_MESSAGES: CorpusMessage[] = [
  { text: "@helper tugas hari ini apa?", expectedCategory: "query" },
  { text: "@helper deadline terdekat apa ya?", expectedCategory: "query" },
  { text: "@helper pekerjaan Agas apa aja?", expectedCategory: "query" },
  { text: "@helper siapa yang belum report?", expectedCategory: "query" },
  { text: "@helper task yang overdue apa aja?", expectedCategory: "query" },
  { text: "@helper status task ganti trafo gardu 5 gimana?", expectedCategory: "query" },
  { text: "@helper ada task tanpa deadline nggak?", expectedCategory: "query" },
  { text: "@helper minggu ini siapa aja yang paling banyak task?", expectedCategory: "query" },
];

export const NOISE_MESSAGES: CorpusMessage[] = [
  { text: "👍", expectedCategory: "noise" },
  { text: "siap", expectedCategory: "noise" },
  { text: "ok makasih", expectedCategory: "noise" },
  { text: "selamat pagi semua", expectedCategory: "noise" },
  { text: "mantap 🔥🔥", expectedCategory: "noise" },
  { text: "hadir", expectedCategory: "noise" },
  { text: "sama-sama", expectedCategory: "noise" },
  { text: "wkwk iya bener", expectedCategory: "noise" },
  { text: "noted", expectedCategory: "noise" },
];

export const COMMAND_MESSAGES: CorpusMessage[] = [
  { text: "@helper buat task ganti trafo gardu 7, deadline tanggal 15", expectedCategory: "command", note: "admin-only action; permission enforced deterministically, not by the LLM" },
  { text: "@helper batalkan task pasang panel C", expectedCategory: "command" },
  { text: "@helper pindahkan task cek kabel ke Budi", expectedCategory: "command" },
  { text: "@helper Agas izin sakit hari ini", expectedCategory: "command" },
  { text: "@helper aktifkan member baru nomor ini", expectedCategory: "command" },
];

export const CLARIFICATION_RESPONSE_MESSAGES: CorpusMessage[] = [
  { text: "tanggal 20 ya", expectedCategory: "clarification_response", note: "reply to the helper's own deadline question" },
  { text: "iya buat task baru aja", expectedCategory: "clarification_response" },
  { text: "bukan, itu task yang lama, gabungkan aja", expectedCategory: "clarification_response" },
  { text: "gapapa cuma aktivitas biasa kok, gausah dibikin task", expectedCategory: "clarification_response" },
];

export const ALL_CORPUS_MESSAGES: CorpusMessage[] = [
  ...REPORT_MESSAGES,
  ...QUERY_MESSAGES,
  ...NOISE_MESSAGES,
  ...COMMAND_MESSAGES,
  ...CLARIFICATION_RESPONSE_MESSAGES,
];
