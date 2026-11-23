import { CANCEL_WORDS, CONFIRM_WORDS } from "../queries/confirmation.ts";

/**
 * The reporter's answer to the numbered plan-match list in the report
 * acknowledgment ("Cek dulu ya"). Parsed by code, never by the LLM — the
 * model is the thing being double-checked.
 *
 * The input is the whole message AFTER the "@helper" mention. Grammar, on the
 * lower-cased text with commas, semicolons, brackets and quotes read as
 * spaces (so "2,3 ya" is "2 3 ya" and "ya 2, bukan 3" is "ya 2 bukan 3"):
 *
 *   reply      := verb                         bulk: every open question
 *               | clause+
 *   clause     := numbers verb                 "N verb" order: 2 ya · 2 3 ya
 *               | verb numbers                 "verb N" order: ya 2 · bukan 2 3
 *               | number arrow planId          correction:      3 = 2.08
 *   verb       := ya iya ok betul benar ...    (CONFIRM_WORDS)  -> confirm
 *               | bukan tidak salah ...        (CANCEL_WORDS + salah) -> reject
 *   arrow      := "=" | "->" | "=>" | "itu" | "jadi"
 *
 * A message mixes at most ONE order for its verb clauses (decided by its
 * first token); corrections can sit anywhere between them. Filler words
 * "dan" and "nomor" are ignored.
 *
 * Three outcomes:
 *  - null      : not a match reply at all (it contains an ordinary word, e.g.
 *                "tugas Nisa besok apa") — the caller treats it as a normal
 *                message / query.
 *  - "invalid" : it is built only from reply vocabulary but cannot be read
 *                without guessing ("2 ya bukan 3", "2", "ya 2 3 bukan") — the
 *                caller answers with a short help text.
 *  - a reply   : usable.
 */
export type ReportMatchVerb = "confirm" | "reject";

export type ReportMatchReply =
  | { kind: "bulk"; verb: ReportMatchVerb }
  | { kind: "items"; decisions: Array<{ n: number; verb: ReportMatchVerb }>; corrections: Array<{ n: number; planId: string }> }
  | { kind: "invalid" };

type Token =
  | { type: "verb"; verb: ReportMatchVerb }
  | { type: "num"; n: number }
  | { type: "id"; id: string }
  | { type: "arrow" };

const FILLER_WORDS = new Set(["dan", "nomor"]);
const ARROW_WORDS = new Set(["->", "=", "itu", "jadi"]);
const TOKEN_PATTERN = /->|=>|=|\d+(?:\.\d+)?|[a-z]+/g;

function verbOf(word: string): ReportMatchVerb | null {
  if (CONFIRM_WORDS.has(word)) return "confirm";
  if (CANCEL_WORDS.has(word) || word === "salah") return "reject";
  return null;
}

function tokenize(text: string): Token[] | null {
  const cleaned = text
    .toLowerCase()
    .replace(/→/g, "->")
    .replace(/[,;:!?[\]()"'`*_~]/g, " ")
    // A sentence-final period ("ya.") is punctuation; the dot inside "2.08" is not.
    .replace(/\.+(?=\s|$)/g, " ");
  const words = cleaned.match(TOKEN_PATTERN) ?? [];
  // Anything the tokenizer could not consume is a character outside the vocabulary.
  if (cleaned.replace(TOKEN_PATTERN, "").trim() !== "") return null;

  const tokens: Token[] = [];
  for (const word of words) {
    if (FILLER_WORDS.has(word)) continue;
    if (word === "=>" || ARROW_WORDS.has(word)) {
      tokens.push({ type: "arrow" });
    } else if (/^\d{1,3}$/.test(word)) {
      tokens.push({ type: "num", n: Number(word) });
    } else if (/^\d{1,3}\.\d{1,3}$/.test(word)) {
      tokens.push({ type: "id", id: word });
    } else {
      const verb = verbOf(word);
      if (!verb) return null;
      tokens.push({ type: "verb", verb });
    }
  }
  return tokens;
}

/** One run of "N… verb" or "verb N…" tokens; null when it cannot be read without guessing. */
function parseVerbSegment(tokens: readonly Token[]): Array<{ n: number; verb: ReportMatchVerb }> | null {
  const out: Array<{ n: number; verb: ReportMatchVerb }> = [];
  const first = tokens[0];
  if (!first) return out;
  let i = 0;

  if (first.type === "num") {
    // numbers then their verb, repeated
    while (i < tokens.length) {
      const numbers: number[] = [];
      while (i < tokens.length && tokens[i]!.type === "num") numbers.push((tokens[i++] as { n: number }).n);
      const verbToken = tokens[i++];
      if (numbers.length === 0 || !verbToken || verbToken.type !== "verb") return null;
      for (const n of numbers) out.push({ n, verb: verbToken.verb });
    }
    return out;
  }

  if (first.type === "verb") {
    // a verb then its numbers, repeated
    while (i < tokens.length) {
      const verbToken = tokens[i++];
      if (!verbToken || verbToken.type !== "verb") return null;
      let count = 0;
      while (i < tokens.length && tokens[i]!.type === "num") {
        out.push({ n: (tokens[i++] as { n: number }).n, verb: verbToken.verb });
        count++;
      }
      if (count === 0) return null;
    }
    return out;
  }

  return null;
}

export function parseReportMatchReply(text: string): ReportMatchReply | null {
  const tokens = tokenize(text);
  if (tokens === null || tokens.length === 0) return null;

  const only = tokens[0];
  if (tokens.length === 1 && only?.type === "verb") return { kind: "bulk", verb: only.verb };

  // Corrections ("3 = 2.08") are lifted out first; each leaves a break so the
  // verb clauses on either side are read as separate runs.
  const corrections: Array<{ n: number; planId: string }> = [];
  const segments: Token[][] = [[]];
  for (let i = 0; i < tokens.length; i++) {
    const [a, b, c] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (a?.type === "num" && b?.type === "arrow" && c?.type === "id") {
      corrections.push({ n: a.n, planId: c.id });
      segments.push([]);
      i += 2;
    } else {
      segments[segments.length - 1]!.push(tokens[i]!);
    }
  }

  const decisions: Array<{ n: number; verb: ReportMatchVerb }> = [];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const parsed = parseVerbSegment(segment);
    if (!parsed) return { kind: "invalid" };
    decisions.push(...parsed);
  }
  if (decisions.length === 0 && corrections.length === 0) return { kind: "invalid" };

  // One number, one instruction.
  const seen = new Map<number, string>();
  for (const d of decisions) {
    const prior = seen.get(d.n);
    if (prior !== undefined && prior !== d.verb) return { kind: "invalid" };
    seen.set(d.n, d.verb);
  }
  for (const c of corrections) {
    if (seen.has(c.n)) return { kind: "invalid" };
    seen.set(c.n, `=${c.planId}`);
  }

  return { kind: "items", decisions, corrections };
}
