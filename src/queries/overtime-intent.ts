/**
 * Deterministic pre-classifier for the overtime (lembur) intents.
 *
 * Why this exists (production, 2026-10-08): the same text, "@bot lembur",
 * from two members one minute apart was read as overtime_checkin once and
 * overtime_today (the LIST) the next time. LLM nondeterminism on a phrase
 * this short and this common is not acceptable, so the obvious phrasings are
 * decided by code BEFORE the model is asked. Anything unusual still goes to
 * the model.
 *
 * Deliberately conservative: a message is classified only when EVERY word of
 * it is understood (the vocabularies below, plus one optional clock time).
 * A name, a day word ("besok", "kemarin", "tanggal ..."), or any other word
 * we do not know makes the function return null, so "Nisa lembur" or
 * "lembur kemarin jam 5" fall through to the LLM instead of being filed as
 * the sender's own check-in. The resulting intent still goes through the same
 * path as an LLM intent, so check-in/checkout still need a confirmation.
 */
export interface OvertimePreIntent {
  intent: "overtime_today" | "overtime_checkin" | "overtime_checkout";
  /** The clock time exactly as written, lower-cased ("jam 5", "17.00", "jam 17:30", "pukul 18", "jam 5 sore"); absent when none was given. */
  timeText?: string;
}

/** "jam 5" stays "jam 5"; "17.00" becomes "jam 17.00" — timeText is stored as written, with or without the word. */
export function clockLabel(timeText: string): string {
  return /^(jam|pukul)\b/i.test(timeText.trim()) ? timeText.trim() : `jam ${timeText.trim()}`;
}

const MAX_WORDS = 10;

/** Question / list markers (single words). */
const QUESTION_WORDS = new Set(["siapa", "apa", "apakah", "berapa", "mana", "list", "lihat", "cek", "rekap"]);
/** Question / list markers (phrases, matched on the normalized text). */
const QUESTION_PHRASES = ["daftar yang", "yang lembur", "yg lembur", "lembur siapa", "siapa aja", "hari ini siapa"];

const CHECKOUT_WORDS = new Set(["selesai", "pulang", "udahan", "stop", "beres", "kelar"]);
/** Question-only support words: in a message that is not a question they mean we do not understand it ("lembur aja", "ada lembur"). */
const QUESTION_SUPPORT_WORDS = new Set(["yang", "yg", "aja", "saja", "ada", "orang", "semua", "kah"]);
/** "udah/sudah lembur" alone is a past-tense remark, not a declaration; only "udah selesai lembur" is. */
const PAST_WORDS = new Set(["udah", "sudah", "sdh"]);
/** Words that only make sense for starting overtime; combined with a checkout word the meaning is unclear. */
const CHECKIN_ONLY_WORDS = new Set(["mulai", "absen", "mengajukan", "ngajukan", "ngejukan", "ajukan", "pengajuan", "daftar", "ikut"]);

/** Everything a declaration or a question may contain besides a clock time. Any other word → null. */
const KNOWN_WORDS = new Set([
  "lembur",
  // check-in vocabulary
  "absen", "mengajukan", "ngajukan", "ngejukan", "ajukan", "pengajuan", "izin", "daftar", "saya", "aku", "ikut", "mulai",
  // checkout vocabulary
  "selesai", "pulang", "udahan", "stop", "beres", "kelar", "udah", "sudah", "sdh",
  // question vocabulary
  "siapa", "apa", "apakah", "berapa", "mana", "list", "lihat", "cek", "rekap", "yang", "yg", "aja", "saja", "ada", "orang", "semua", "kah",
  // harmless fillers and "today" words
  "ya", "dong", "nih", "deh", "dulu", "hari", "ini", "malam", "sore", "sekarang", "juga",
]);

/** The bot's own tag: "@helper" anywhere, or the leading WhatsApp mention number. A later @number is another person and stays (so it blocks classification). */
const BOT_MENTION = /^\s*(?:@\d+\s*)+|(?<=^|\s)@helper\b/gi;

/**
 * A clock time: "jam 5", "jam 17.00", "jam 17:30", "pukul 18", or a bare
 * "17.00"/"17:30". The whole match is kept as written, including an
 * immediately following part-of-day word ("jam 5 sore"), because the owner
 * reads these strings directly. Code that prints it must not prepend another
 * "jam" (see clockLabel below).
 */
const TIME_PATTERN = /(?:\b(?:jam|pukul)\s*\d{1,2}(?:[.:]\d{2})?|(?<![\d.:])\d{1,2}[.:]\d{2}(?![\d.:]))(?:\s+(?:sore|malam|pagi|siang|wib))?/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(BOT_MENTION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!,;:]+$/, "")
    .trim();
}

export function classifyOvertimeIntent(rawText: string): OvertimePreIntent | null {
  const text = normalize(rawText);
  if (text === "") return null;

  // Pull out the clock time first so its digits and "jam" are not mistaken for unknown words.
  let timeText: string | undefined;
  let rest = text;
  const timeMatch = TIME_PATTERN.exec(text);
  if (timeMatch) {
    timeText = timeMatch[0].trim();
    rest = `${text.slice(0, timeMatch.index)} ${text.slice(timeMatch.index + timeMatch[0].length)}`;
  }

  const hasQuestionMark = rest.includes("?");
  const words = rest
    .replace(/\?/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}@]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w !== "");

  if (!words.includes("lembur")) return null;
  if (text.split(" ").length > MAX_WORDS) return null;
  // One unknown word (a name, "besok", "tanggal", a stray number) and we stay out of it.
  if (words.some((w) => !KNOWN_WORDS.has(w))) return null;

  const normalized = words.join(" ");
  const isQuestion =
    hasQuestionMark || words.some((w) => QUESTION_WORDS.has(w)) || QUESTION_PHRASES.some((p) => normalized.includes(p));
  // A question only reads: it never carries a time and never marks anyone.
  if (isQuestion) return { intent: "overtime_today" };

  if (words.some((w) => QUESTION_SUPPORT_WORDS.has(w))) return null;

  const isCheckout = words.some((w) => CHECKOUT_WORDS.has(w));
  if (!isCheckout && words.some((w) => PAST_WORDS.has(w))) return null;
  if (isCheckout) {
    if (words.some((w) => CHECKIN_ONLY_WORDS.has(w))) return null;
    return { intent: "overtime_checkout", ...(timeText ? { timeText } : {}) };
  }

  return { intent: "overtime_checkin", ...(timeText ? { timeText } : {}) };
}
