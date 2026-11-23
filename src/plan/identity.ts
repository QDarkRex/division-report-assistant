/**
 * Who is who when the supervisor renumbers the plan. Pure: no I/O.
 *
 * Why the sheet's ID cannot be the identity. Between 2026-10-01 and
 * 2026-10-03 the supervisor REUSED IDs for different steps: old 5.03 "QC dan
 * pemasangan box kontroler baru (mobil aerolift drone 2)" became new 5.03
 * "Wiring box PSU mobil aerolift drone 2" while the QC step moved to 5.04.
 * Keying tasks purely by ID would have silently turned one task into a
 * different step and attached its report history to the wrong work. So a
 * task's identity is "which step is it" — recognised by the step's text — and
 * the ID is just where that step currently sits.
 *
 * The matching runs in passes, all against one sheet snapshot:
 *   1. same ID and the same step                    -> the same task, kept
 *   2. remaining rows vs remaining live items, same area, same step
 *                                                   -> the task MOVED to the new ID
 *   3. remaining rows vs items already marked missing, same area, same step
 *                                                   -> the step REAPPEARED
 *   4. remaining rows                               -> new steps (added)
 *   5. remaining live items                         -> gone from the sheet (removed)
 * In passes 2 and 3 several rows may fit one old step (a drone-1 twin of a
 * drone-2 step) and the other way round. Every qualifying pair is ranked by
 * (identical text first, similarity score, ID distance within the area, i.e.
 * how far apart the step numbers are) and assigned one-to-one, best first.
 * Only a tie on ALL of those between pairs that share an item is ambiguous:
 * nobody is guessed, the items fall through (and are reported), because
 * attaching a task's history to the wrong twin is worse than treating the
 * step as new.
 */

/** Words that carry no identity in this plan's step texts ("… box controller … mobil aerolift drone 2"). */
export const STEP_STOPWORDS: ReadonlySet<string> = new Set([
  "dan",
  "yang",
  "ke",
  "di",
  "untuk",
  "dengan",
  "baru",
  "mobil",
  "aerolift",
  "drone",
  "box",
  "the",
  "of",
]);

/**
 * Domain vocabulary from the real sheet: spellings the supervisor uses
 * interchangeably for one thing (power box = "box daya" = "box PSU";
 * "kontroler" / "controller"; "pengujian" / "testing" / "test" all mean the
 * step "pengetesan"). Applied to each token before stopwords and the
 * similarity are looked at. Extend it when the sheet shows a new pair.
 */
export const STEP_SYNONYMS: Readonly<Record<string, string>> = {
  psu: "daya",
  power: "daya",
  kontroler: "controller",
  pengujian: "pengetesan",
  testing: "pengetesan",
  test: "pengetesan",
};

/** Minimum containment for two step texts to count as the same step. */
export const SAME_STEP_THRESHOLD = 0.6;

export interface StepTokens {
  /** Distinct non-number, non-stopword tokens. */
  words: Set<string>;
  /** Distinct number tokens ("2", "1.5"): "drone 1" and "drone 2" are different steps. */
  numbers: Set<string>;
  /** The normalized text, stopwords included: equal strings are the same step whatever they contain. */
  normalized: string;
}

const NUMBER = /^\d+(?:[.,]\d+)?$/;

/** lowercase, punctuation and parentheses stripped, split on whitespace / en dash / hyphen. */
export function tokenizeStep(text: string): StepTokens {
  const lowered = text.toLowerCase().replace(/[()[\]{}"'“”‘’,;:!?/\\|&]/g, " ");
  const all: string[] = [];
  for (const raw of lowered.split(/[\s–—-]+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (token !== "") all.push(STEP_SYNONYMS[token] ?? token);
  }
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const token of all) {
    if (NUMBER.test(token)) numbers.add(token.replace(",", "."));
    else if (!STEP_STOPWORDS.has(token)) words.add(token);
  }
  return { words, numbers, normalized: all.join(" ") };
}

export interface StepSimilarity {
  same: boolean;
  /** Containment of the non-number tokens: overlap / min(|A|, |B|). 1 for identical text. 0 when a side has no words. */
  score: number;
  /** The number-token condition: equal sets, or one side has none. */
  numbersCompatible: boolean;
  /** The two texts normalize to exactly the same string. */
  exact: boolean;
}

/**
 * Two steps are "the same" iff (a) their number sets are equal or one side has
 * none, and (b) containment >= 0.6 with at least one word on the smaller side.
 * Containment rather than Jaccard so that a step which only gained a suffix
 * ("... rak mobil" -> "... rak mobil aerolift drone 2") is still itself.
 */
export function stepSimilarity(a: string, b: string): StepSimilarity {
  const ta = tokenizeStep(a);
  const tb = tokenizeStep(b);
  const exact = ta.normalized === tb.normalized && ta.normalized !== "";
  const numbersCompatible =
    ta.numbers.size === 0 ||
    tb.numbers.size === 0 ||
    (ta.numbers.size === tb.numbers.size && [...ta.numbers].every((n) => tb.numbers.has(n)));
  const smaller = Math.min(ta.words.size, tb.words.size);
  let score = 0;
  if (smaller >= 1) {
    let overlap = 0;
    for (const w of ta.words) if (tb.words.has(w)) overlap++;
    score = overlap / smaller;
  }
  if (exact) return { same: true, score: 1, numbersCompatible: true, exact: true };
  return { same: numbersCompatible && smaller >= 1 && score >= SAME_STEP_THRESHOLD, score, numbersCompatible, exact: false };
}

const normalizeArea = (area: string): string => area.replace(/\s+/g, " ").trim().toLowerCase();

/** What the database already knows about one plan step. `key` is whatever identifies it to the caller (the task id). */
export interface IdentityEntry {
  key: string;
  /** The sheet ID it last sat at, e.g. "5.03". */
  id: string;
  area: string;
  step: string;
  /** Already marked missing by an earlier run. */
  missing: boolean;
}

export interface IdentityRow {
  id: string;
  area: string;
  step: string;
}

export interface IdentityPair<E extends IdentityEntry, R extends IdentityRow> {
  entry: E;
  row: R;
  score: number;
}

export interface IdentityAmbiguity {
  pass: "moved" | "reappeared";
  rowIds: string[];
  entryIds: string[];
}

export interface IdentityPlan<E extends IdentityEntry, R extends IdentityRow> {
  /** Same ID, same step. */
  kept: Array<IdentityPair<E, R>>;
  /** A live item whose step now sits at a different ID. */
  moved: Array<IdentityPair<E, R>>;
  /** An item that was marked missing and whose step is back (at its old ID or another). */
  reappeared: Array<IdentityPair<E, R>>;
  added: R[];
  removed: E[];
  ambiguous: IdentityAmbiguity[];
}

/** "6.06" -> { area: 6, step: 6 }; null for an ID that is not dotted numbers. */
function parseId(id: string): { area: number; step: number } | null {
  const m = /^(\d+)\.(\d+)$/.exec(id.trim());
  return m ? { area: Number(m[1]), step: Number(m[2]) } : null;
}

/** How far apart two step numbers are: 6.06 vs 6.07 = 1, vs 6.13 = 7. Different areas count as very far. */
export function idDistance(a: string, b: string): number {
  const pa = parseId(a);
  const pb = parseId(b);
  if (!pa || !pb) return a === b ? 0 : 1_000_000;
  return pa.area === pb.area ? Math.abs(pa.step - pb.step) : 1_000 + Math.abs(pa.area - pb.area) * 100 + Math.abs(pa.step - pb.step);
}

interface Candidate<E extends IdentityEntry, R extends IdentityRow> {
  row: R;
  entry: E;
  sim: StepSimilarity;
  distance: number;
}

/** Best first: identical text, then higher score, then the nearer ID. The tie-break by ID text only makes the order deterministic. */
function rankKey<E extends IdentityEntry, R extends IdentityRow>(c: Candidate<E, R>): [number, number, number] {
  return [c.sim.exact ? 0 : 1, -c.sim.score, c.distance];
}

function sameRank<E extends IdentityEntry, R extends IdentityRow>(a: Candidate<E, R>, b: Candidate<E, R>): boolean {
  const ka = rankKey(a);
  const kb = rankKey(b);
  return ka[0] === kb[0] && Math.abs(ka[1] - kb[1]) < 1e-9 && ka[2] === kb[2];
}

function compareCandidates<E extends IdentityEntry, R extends IdentityRow>(a: Candidate<E, R>, b: Candidate<E, R>): number {
  const ka = rankKey(a);
  const kb = rankKey(b);
  return ka[0] - kb[0] || (Math.abs(ka[1] - kb[1]) < 1e-9 ? 0 : ka[1] - kb[1]) || ka[2] - kb[2] || a.entry.id.localeCompare(b.entry.id, "en", { numeric: true }) || a.row.id.localeCompare(b.row.id, "en", { numeric: true });
}

/**
 * Deterministic one-to-one assignment of rows to entries among those that
 * qualify as the same step. Best pair first; a tie on the whole rank between
 * pairs that share a row or an entry is ambiguous and drops every pair that
 * involves the contested rows/entries.
 */
function assignBest<E extends IdentityEntry, R extends IdentityRow>(
  rows: R[],
  entries: E[],
  qualify: (row: R, entry: E) => StepSimilarity | null,
): { pairs: Array<IdentityPair<E, R>>; contested: Array<{ rows: R[]; entries: E[] }> } {
  let candidates: Array<Candidate<E, R>> = [];
  for (const row of rows) {
    for (const entry of entries) {
      const sim = qualify(row, entry);
      if (sim) candidates.push({ row, entry, sim, distance: idDistance(entry.id, row.id) });
    }
  }
  const pairs: Array<IdentityPair<E, R>> = [];
  const contested: Array<{ rows: R[]; entries: E[] }> = [];
  while (candidates.length > 0) {
    candidates.sort(compareCandidates);
    const best = candidates[0] as Candidate<E, R>;
    const group = candidates.filter((c) => sameRank(c, best));
    const rowUse = new Map<R, number>();
    const entryUse = new Map<E, number>();
    for (const c of group) {
      rowUse.set(c.row, (rowUse.get(c.row) ?? 0) + 1);
      entryUse.set(c.entry, (entryUse.get(c.entry) ?? 0) + 1);
    }
    const clean = group.filter((c) => rowUse.get(c.row) === 1 && entryUse.get(c.entry) === 1);
    const dropRows = new Set<R>();
    const dropEntries = new Set<E>();
    if (clean.length > 0) {
      for (const c of clean) {
        pairs.push({ entry: c.entry, row: c.row, score: c.sim.score });
        dropRows.add(c.row);
        dropEntries.add(c.entry);
      }
    } else {
      // Everything at the top rank is contested: nobody is guessed.
      contested.push({ rows: [...rowUse.keys()], entries: [...entryUse.keys()] });
      for (const r of rowUse.keys()) dropRows.add(r);
      for (const e of entryUse.keys()) dropEntries.add(e);
    }
    candidates = candidates.filter((c) => !dropRows.has(c.row) && !dropEntries.has(c.entry));
  }
  return { pairs, contested };
}

export function matchPlanIdentity<E extends IdentityEntry, R extends IdentityRow>(entries: readonly E[], rows: readonly R[]): IdentityPlan<E, R> {
  const plan: IdentityPlan<E, R> = { kept: [], moved: [], reappeared: [], added: [], removed: [], ambiguous: [] };
  let rowsLeft = [...rows];
  let live = entries.filter((e) => !e.missing);
  let missing = entries.filter((e) => e.missing);

  const take = <T>(list: T[], gone: Iterable<T>): T[] => {
    const set = new Set(gone);
    return list.filter((x) => !set.has(x));
  };

  // 1. Same ID and the same step.
  const liveById = new Map(live.map((e) => [e.id, e]));
  for (const row of rowsLeft) {
    const entry = liveById.get(row.id);
    if (!entry) continue;
    const sim = stepSimilarity(entry.step, row.step);
    if (sim.same) plan.kept.push({ entry, row, score: sim.score });
  }
  rowsLeft = take(rowsLeft, plan.kept.map((p) => p.row));
  live = take(live, plan.kept.map((p) => p.entry));

  // 2./3. Moved, then reappeared: best qualifying pair first, one-to-one.
  const sameArea = (r: R, e: E) => normalizeArea(r.area) === normalizeArea(e.area);
  const qualify = (r: R, e: E): StepSimilarity | null => {
    if (!sameArea(r, e)) return null;
    const sim = stepSimilarity(e.step, r.step);
    return sim.same ? sim : null;
  };
  {
    const { pairs, contested } = assignBest(rowsLeft, live, qualify);
    for (const c of contested) plan.ambiguous.push({ pass: "moved", rowIds: [...new Set(c.rows.map((r) => r.id))], entryIds: c.entries.map((e) => e.id) });
    plan.moved.push(...pairs);
    rowsLeft = take(rowsLeft, pairs.map((p) => p.row));
    live = take(live, pairs.map((p) => p.entry));
  }
  {
    const { pairs, contested } = assignBest(rowsLeft, missing, qualify);
    for (const c of contested) plan.ambiguous.push({ pass: "reappeared", rowIds: [...new Set(c.rows.map((r) => r.id))], entryIds: c.entries.map((e) => e.id) });
    plan.reappeared.push(...pairs);
    rowsLeft = take(rowsLeft, pairs.map((p) => p.row));
    missing = take(missing, pairs.map((p) => p.entry));
  }

  plan.added = rowsLeft;
  plan.removed = live;
  return plan;
}
