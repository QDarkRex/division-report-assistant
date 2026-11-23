/**
 * MASTER_SPEC.md §9.2: "Valid report requires a clear header: report,
 * report Agas, daily report, etc. A bullet list without header asks for
 * confirmation." Deterministic pre-filter — §4.5 item 1 requires
 * deterministic filtering before any LLM call, and this is exactly that:
 * whether a message is even a report candidate is a plain check, not
 * something that needs an LLM round-trip.
 *
 * Tightened (2026-08-07, earlier): a plain prefix check ("starts with
 * report/laporan") false-positives on ordinary sentences that happen to
 * start with that word — e.g. an admin reminder "Report harian jangan
 * lupa ya semua" would wrongly get sent to the LLM. Fixed by capping the
 * header line at ≤3 trailing words after the keyword.
 *
 * Loosened again same day, live-verified failure: a real report from the
 * owner, "Report Affan Jumat 7 Agustus 2026" (name + weekday + full date),
 * has 5 trailing words — the ≤3 cap silently dropped it into ephemeral
 * context storage instead of processing it. A pure word-count cap can't
 * distinguish this from the reminder case above; they're the same length.
 * The actual distinguishing signal is a recognizable date token (weekday,
 * month name, or 4-digit year) — reminders don't have one, real headers
 * naming a day/date do. So: keep the tight ≤3-word cap as the default, but
 * also accept up to 8 trailing words when at least one is a date token.
 * Deliberately NOT matching bare 1-2 digit numbers as a date signal (e.g.
 * "jam 9" in "Laporan hari ini paling lambat jam 9 ya") — too common in
 * ordinary sentences to be a reliable signal; only a full 4-digit year
 * counts numerically.
 *
 * Loosened twice more on 2026-09-05, both from one member's five failed
 * attempts in nine minutes ("ko ga ngarti bro @helper" between them):
 *
 *  - Emphasis marks. WhatsApp bolds with *asterisks* and people paste
 *    **markdown** too, so "*Report Gunawan*" and "**Report Gunawam**"
 *    never even reached the keyword test — the line starts with an
 *    asterisk, not with "report". Marks are stripped before matching.
 *  - A colon with content after it. "report gunawan : Perakitan
 *    Antarmuka Audio LattePanda & Samsung A06" is a header followed by a
 *    subject on the same line; only the part before the colon is a header
 *    claim, so that is what gets tested. The reminder false-positives
 *    this guard exists for ("Report harian jangan lupa ya semua",
 *    "Laporan hari ini paling lambat jam 9 ya") carry no colon, so the
 *    split does not weaken them.
 *
 * He got there in the end, by retyping it plain. Four reports before that
 * went to ephemeral context storage instead, with no reply telling him
 * why — from his side the bot had simply ignored him.
 */

/**
 * WhatsApp emphasis (*bold*, _italic_, ~strike~) and pasted markdown
 * (**bold**, # heading) around the header line. Stripped from both ends
 * only: an asterisk in the middle of a sentence is not decoration.
 */
const EMPHASIS_EDGE_PATTERN = /^[\s*_~#`]+|[\s*_~#`]+$/g;

/** Exported only so its regex can be asserted directly — see header.test.ts. */
export function stripEmphasis(line: string): string {
  return line.replace(EMPHASIS_EDGE_PATTERN, "");
}

/**
 * "report gunawan : Perakitan Antarmuka ..." -> "report gunawan".
 * Only when something follows the colon; a trailing colon is already
 * handled by the header patterns themselves.
 */
function headerClaim(line: string): string {
  const colon = line.indexOf(":");
  if (colon <= 0 || colon === line.length - 1) return line;
  return line.slice(0, colon);
}
const HEADER_KEYWORD_PATTERN = /^\s*(?:daily\s+report|laporan\s+harian|report|laporan|lembur|overtime)\b/i;
const SHORT_HEADER_LINE_PATTERN = /^\s*(?:daily\s+report|laporan\s+harian|report|laporan|lembur|overtime)(?:\s+[\w'-]+){0,3}\s*[:.]?\s*$/i;
const DATE_SIGNAL_PATTERN =
  /\b(?:senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|\d{4})\b/i;

function isReportHeaderLine(rawLine: string): boolean {
  const line = stripEmphasis(rawLine);
  if (!HEADER_KEYWORD_PATTERN.test(line)) return false;
  if (matchesHeaderShape(line)) return true;
  // Fall back to the part before a colon, so a header carrying its subject
  // on the same line still counts.
  const claim = stripEmphasis(headerClaim(line));
  return claim !== line && matchesHeaderShape(claim);
}

// A line that starts with the keyword and NAMES A DATE is a header, whatever
// punctuation sits between. The old LONG rule required the whole line to be
// keyword + bare word-tokens, so an em dash or a comma broke it: "Report
// Pengerjaan — Selasa, 22 September 2026" silently failed and dropped three
// of Gunawan's reports on 2026-09-22 with no reply. The date signal is what
// keeps a reminder out ("Report harian jangan lupa ya" cites no date); the
// word cap keeps a whole paragraph that merely mentions a month from
// counting. Neither cares about dashes or commas any more.
const MAX_HEADER_WORDS = 12;

function matchesHeaderShape(line: string): boolean {
  if (SHORT_HEADER_LINE_PATTERN.test(line)) return true;
  if (!DATE_SIGNAL_PATTERN.test(line)) return false;
  return line.trim().split(/\s+/).length <= MAX_HEADER_WORDS;
}

const OVERTIME_HEADER_PATTERN = /(?:^|\s)(?:lembur|overtime)(?:\s|$)/i;

/**
 * True when the report is an OVERTIME report — headed "Report lembur",
 * "Lembur Agas", "Report overtime", and so on. Read from the header words
 * alone and never from the model: overtime decides which report a
 * member's work lands in (regular vs lembur), and that routing has to be
 * deterministic. Staff-and-above Saturday work is overtime too, but that
 * rule needs the member level and the day, so it lives in the pipeline —
 * this function only reads the text.
 *
 * Only lines that are themselves valid report headers count, so a normal
 * report whose body mentions "lembur" ("bantu lembur bang Agas") is not
 * misread as an overtime report.
 */
export function isOvertimeReport(text: string): boolean {
  return text.split("\n").some((line) => isReportHeaderLine(line) && OVERTIME_HEADER_PATTERN.test(stripEmphasis(line)));
}

export function hasReportHeader(text: string): boolean {
  return text.split("\n").some(isReportHeaderLine);
}

const REPORT_WORD_PATTERN = /^(?:report|laporan|lapor)(?![a-z0-9])/i;
/** A one-line message this long is a pasted report body, not a chat line. */
const REPORT_ATTEMPT_MIN_CHARS = 150;
const REPORT_ATTEMPT_MIN_LINES = 3;

/**
 * A message that LOOKS like someone's report but that `hasReportHeader`
 * rejected — so it was not recorded, and the sender should be told rather
 * than left believing it was (2026-10: a member's single 560-character
 * paragraph "report hari ini saya melakukan troubleshooting ..." got no
 * reply at all).
 *
 * Deterministic, three conditions, on text that has ALREADY been through
 * normalizeIncomingText:
 *  1. the first non-empty line begins with report / laporan / lapor
 *     (emphasis marks like * _ ~ ignored);
 *  2. the message is body-sized: at least 3 non-empty lines, or at least 150
 *     characters — so "udah report belum?", "lapor dong" and the like never
 *     match (they also fail 1 or 2);
 *  3. it is not a question: a short-form message ending in "?" is chat.
 *
 * The caller is responsible for the fourth condition — that the message was
 * not processed as a report (and was not addressed to the bot as a query).
 */
export function looksLikeReportAttempt(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0];
  if (first === undefined || !REPORT_WORD_PATTERN.test(stripEmphasis(first))) return false;
  const trimmed = text.trim();
  if (lines.length < REPORT_ATTEMPT_MIN_LINES && trimmed.length < REPORT_ATTEMPT_MIN_CHARS) return false;
  if (lines.length < REPORT_ATTEMPT_MIN_LINES && trimmed.endsWith("?")) return false;
  return true;
}
