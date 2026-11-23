import { bold, clampMessage } from "../format/wa.ts";
import { clip, type PerhatianKind, type RecapPlan } from "./llm.ts";
import { computeStalled, FALLBACK_STREAM_ID, weekdayOf, WEEKDAY_SHORT, type StalledStream, type WeeklyRecapFacts } from "./facts.ts";

/**
 * Deterministic rendering of the weekly recap (ADR-0016). Every number, day
 * label, name list and the "tanpa laporan" line come from code; the model's
 * only contribution is the text of a bullet. WhatsApp style as in
 * src/format/wa.ts: bold title, "• " bullets, one blank line between blocks.
 */

export const MAX_RECAP_CHARS = 3000;
const TOP_STREAMS = 3;
const SECOND_STREAMS = 3;
const MEMBERS_SHOWN = 5;
/** PERLU PERHATIAN shows at most this many lines, except that every insiden line is kept. */
export const MAX_PERHATIAN_LINES = 6;

const WEEKDAY_LONG = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

const KIND_ORDER: Record<PerhatianKind, number> = { insiden: 0, komponen: 1, tertahan: 2, lain: 3 };

// --- day labels ---------------------------------------------------------------------

/** Monday-first position, so "Sen–Rab" runs forward and Sunday closes the week. */
const mondayFirst = (isoDay: string) => (weekdayOf(isoDay) + 6) % 7;

/**
 * "Sen:", "Sen–Rab:", "Sen, Kam:" from the days of the evidence items: runs of
 * three or more consecutive days are ranges, everything else is listed, so the
 * label never claims a day that has no evidence.
 */
export function dayLabelOf(days: readonly string[]): string {
  const idx = [...new Set(days.map(mondayFirst))].sort((a, b) => a - b);
  const short = (i: number) => WEEKDAY_SHORT[(i + 1) % 7]!;
  const parts: string[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${short(idx[i]!)}–${short(idx[j]!)}`);
    else for (let k = i; k <= j; k++) parts.push(short(idx[k]!));
    i = j + 1;
  }
  return parts.join(", ");
}

function parseDay(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** "13 Nov" */
function shortDate(iso: string): string {
  const { m, d } = parseDay(iso);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "Senin 16 – Minggu 22 Nov 2026" */
export function weekRangeLabel(weekStart: string, weekEnd: string): string {
  const a = parseDay(weekStart);
  const b = parseDay(weekEnd);
  const from = a.m === b.m ? `${a.d}` : `${a.d} ${MONTHS[a.m - 1]}`;
  return `${WEEKDAY_LONG[weekdayOf(weekStart)]} ${from} – ${WEEKDAY_LONG[weekdayOf(weekEnd)]} ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

// --- the view: facts + validated plan -> what gets printed ---------------------------

export interface StreamView {
  streamId: string;
  name: string;
  shortName: string;
  itemCount: number;
  prevCount: number;
  members: string[];
  /** Chronological by first evidence day; label is computed from the evidence. */
  bullets: Array<{ label: string; text: string; evidenceItemIds: string[] }>;
  blockedCount: number;
}

export interface RecapView {
  facts: WeeklyRecapFacts;
  streams: StreamView[];
  /** Capped (see MAX_PERHATIAN_LINES), ordered insiden, komponen, tertahan, lain. */
  perhatian: Array<{ kind: PerhatianKind; label: string; text: string }>;
  /** Lines left out by the cap; the message points to the spreadsheet for them. */
  perhatianCut: number;
  stalled: StalledStream[];
}

export function buildRecapView(facts: WeeklyRecapFacts, plan: RecapPlan): RecapView {
  const names = new Map<string, { name: string; shortName: string }>();
  for (const s of facts.registry) names.set(s.streamId, { name: s.name, shortName: s.shortName });
  for (const s of plan.newStreams) names.set(s.streamId, { name: s.name, shortName: s.shortName });

  const byAlias = new Map(facts.items.map((i) => [i.alias, i]));
  const daysOf = (aliases: readonly string[]) => aliases.map((a) => byAlias.get(a)!.day);

  const perStream = new Map<string, typeof facts.items>();
  for (const item of facts.items) {
    const id = plan.assignment.get(item.alias) ?? FALLBACK_STREAM_ID;
    perStream.set(id, [...(perStream.get(id) ?? []), item]);
  }

  const streams: StreamView[] = [...perStream].map(([streamId, items]) => {
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.member, (counts.get(i.member) ?? 0) + 1);
    const members = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
    const bullets = (plan.bullets.get(streamId) ?? [])
      .map((b, order) => ({ b, order, first: daysOf(b.evidence).sort()[0]! }))
      .sort((x, y) => x.first.localeCompare(y.first) || x.order - y.order)
      .map(({ b }) => ({ label: dayLabelOf(daysOf(b.evidence)), text: b.text, evidenceItemIds: b.evidence.map((a) => byAlias.get(a)!.itemId) }));
    const n = names.get(streamId) ?? { name: streamId, shortName: streamId };
    return {
      streamId,
      ...n,
      itemCount: items.length,
      prevCount: facts.prevActivity[streamId]?.prevCount ?? 0,
      members,
      bullets,
      blockedCount: items.filter((i) => i.status === "blocked").length,
    };
  });

  // Kind first, then the newest evidence day first, then the model's order. All insiden stay; the rest fill up to the cap in that order.
  const ordered = plan.perhatian
    .map((p, order) => ({ p, order, last: daysOf(p.evidence).sort().at(-1)! }))
    .sort((x, y) => KIND_ORDER[x.p.kind] - KIND_ORDER[y.p.kind] || y.last.localeCompare(x.last) || x.order - y.order);
  const insiden = ordered.filter((x) => x.p.kind === "insiden").length;
  const kept = ordered.slice(0, Math.max(MAX_PERHATIAN_LINES, insiden));
  const perhatian = kept.map(({ p }) => ({ kind: p.kind, label: dayLabelOf(daysOf(p.evidence)), text: p.text }));
  const perhatianCut = ordered.length - kept.length;

  const stalled = computeStalled(facts, new Set(perStream.keys()), new Map([...names].map(([id, n]) => [id, n.shortName])));
  return { facts, streams, perhatian, perhatianCut, stalled };
}

// --- the message --------------------------------------------------------------------------

function headerLines(facts: WeeklyRecapFacts): string {
  const prev = (n: number) => (facts.prevItemCount > 0 || facts.prevBlockedCount > 0 ? ` (pekan lalu ${n})` : "");
  return [
    bold("REKAP MINGGUAN DIVISI EE"),
    weekRangeLabel(facts.weekStart, facts.weekEnd),
    `${facts.memberCount} orang melapor · ${facts.itemCount} butir kerja${prev(facts.prevItemCount)} · ${facts.blockedCount} tertahan${prev(facts.prevBlockedCount)}`,
  ].join("\n");
}

interface RenderState {
  topCap: number;
  secondCap: number;
  perhatian: RecapView["perhatian"];
  stalled: StalledStream[];
  perhatianCut: number;
  lainnya: number; // how many "Lainnya" entries are kept
}

function renderState(view: RecapView, s: RenderState): string {
  const ranked = view.streams
    .filter((x) => x.streamId !== FALLBACK_STREAM_ID)
    .sort((a, b) => b.itemCount - a.itemCount || b.prevCount - a.prevCount || a.streamId.localeCompare(b.streamId));
  const fallback = view.streams.filter((x) => x.streamId === FALLBACK_STREAM_ID);
  const shown = ranked.slice(0, TOP_STREAMS + SECOND_STREAMS);
  const rest = [...ranked.slice(TOP_STREAMS + SECOND_STREAMS), ...fallback];

  // A stream with no bullet left (none written, or all trimmed) is not printed as a bare header: it joins "Lainnya".
  const withBullets: Array<{ st: StreamView; lines: string[] }> = [];
  const folded: StreamView[] = [];
  shown.forEach((st, i) => {
    const lines = st.bullets.slice(0, i < TOP_STREAMS ? s.topCap : s.secondCap).map((b) => `• ${b.label}: ${b.text}`);
    if (lines.length > 0) withBullets.push({ st, lines });
    else folded.push(st);
  });
  const blocks = withBullets.map(({ st, lines }, i) => {
    const members = st.members.slice(0, MEMBERS_SHOWN).join(", ");
    const meta = `${st.itemCount} butir${st.prevCount > 0 ? `, pekan lalu ${st.prevCount}` : ""}${members ? ` · ${members}` : ""}`;
    return [`${bold(`${i + 1}. ${st.name}`)} (${meta})`, ...lines].join("\n");
  });
  const others = [...folded, ...rest];
  const lainnya =
    others.length > 0 && s.lainnya > 0 ? `${bold("Lainnya:")} ${others.slice(0, s.lainnya).map((r) => `${r.shortName} ${r.itemCount}`).join(" · ")}` : null;

  const attention = [
    ...s.perhatian.map((p) => `• ${p.label}: ${p.text}`),
    ...(s.perhatianCut > 0 ? [`• +${s.perhatianCut} lainnya di spreadsheet`] : []),
    ...(s.stalled.length > 0 ? [`• Tanpa laporan pekan ini: ${s.stalled.map((x) => `${x.shortName} (terakhir ${shortDate(x.lastDay)})`).join(" · ")}`] : []),
  ];
  const perhatian = attention.length > 0 ? [bold("PERLU PERHATIAN"), ...attention].join("\n") : null;

  return [headerLines(view.facts), ...blocks, lainnya, perhatian].filter((b): b is string => !!b).join("\n\n");
}

/**
 * The Sunday message, at most MAX_RECAP_CHARS. The perhatian cap is already
 * applied in buildRecapView. When still too long it gives up, in order: bullets
 * of the lower streams (down to one each), bullets of the top streams (down to
 * one each), the lower streams altogether (they fold into "Lainnya"), the
 * stalled list, perhatian lines from "lain" up to "komponen" (insiden lines are
 * never dropped), the top streams' last bullets, then "Lainnya" entries. The
 * final clamp only matters if the insiden lines alone exceed the limit.
 */
export function renderWeeklyRecap(view: RecapView): string {
  const s: RenderState = { topCap: 3, secondCap: 2, perhatian: [...view.perhatian], stalled: [...view.stalled], perhatianCut: view.perhatianCut, lainnya: view.streams.length };
  const tooLong = () => renderState(view, s).length > MAX_RECAP_CHARS;
  const steps: Array<() => void> = [() => (s.secondCap = 1), () => (s.topCap = 2), () => (s.topCap = 1), () => (s.secondCap = 0)];
  for (const step of steps) {
    if (!tooLong()) break;
    step();
  }
  while (tooLong() && s.stalled.length > 0) s.stalled.pop();
  while (tooLong()) {
    const kinds = s.perhatian.map((p) => p.kind);
    const idx = Math.max(kinds.lastIndexOf("lain"), kinds.lastIndexOf("tertahan"), kinds.lastIndexOf("komponen"));
    if (idx < 0) break;
    s.perhatian.splice(idx, 1);
    s.perhatianCut++;
  }
  if (tooLong()) s.topCap = 0;
  while (tooLong() && s.lainnya > 0) s.lainnya--;
  return clampMessage(renderState(view, s), MAX_RECAP_CHARS);
}

// --- fallback when the model could not be used -------------------------------------------

/**
 * Header, per-stream counts (from assignments persisted earlier; null = not
 * grouped yet) and the blocked items as reported. No model, nothing guessed.
 */
export function renderFallbackRecap(facts: WeeklyRecapFacts): string {
  const names = new Map(facts.registry.map((r) => [r.streamId, r.shortName]));
  const counts = new Map<string, number>();
  for (const i of facts.items) counts.set(i.workStreamId ?? "", (counts.get(i.workStreamId ?? "") ?? 0) + 1);
  const countLines = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `• ${id ? (names.get(id) ?? id) : "Belum dikelompokkan"}: ${n}`);

  const blocked = facts.items.filter((i) => i.status === "blocked");
  const blockedLines = blocked.slice(0, 15).map((i) => `• ${dayLabelOf([i.day])}: ${clip(i.activity, 90)}${i.obstacle ? ` — ${clip(i.obstacle, 80)}` : ""} (${i.member})`);
  if (blocked.length > 15) blockedLines.push(`• +${blocked.length - 15} lainnya`);

  return clampMessage(
    [
      headerLines(facts),
      "Ringkasan otomatis per aliran kerja tidak tersedia pekan ini; berikut angka dan butir tertahan apa adanya.",
      countLines.length > 0 ? [bold("Butir per aliran kerja"), ...countLines].join("\n") : null,
      blockedLines.length > 0 ? [bold("Butir tertahan"), ...blockedLines].join("\n") : null,
    ]
      .filter((b): b is string => !!b)
      .join("\n\n"),
    MAX_RECAP_CHARS,
  );
}
