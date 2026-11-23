import {
  bold,
  bulletList,
  clampMessage,
  countsLine,
  dayLabel,
  joinBlocks,
  obstacleCategoryLabel,
  section,
  titleLine,
} from "../format/wa.ts";
import { calendarDayDiff, calendarDayOf, type CalendarDay } from "../shared/time.ts";
import {
  planIdOf,
  type BriefDueItem,
  type BriefFlag,
  type BriefPlanChangeGroup,
  type BriefPlanRef,
  type BriefReportBlocker,
  type MorningBriefFacts,
} from "./facts.ts";
import type { BriefLlmOutput } from "./llm.ts";

/**
 * The morning brief as the WhatsApp message. Pure and deterministic: the
 * same facts and the same LLM output give the same text. Every number, name
 * and list below comes from the facts; the LLM contributes only its own
 * sentences (ringkasan, alasan, masalah, saran), and a step it cites is
 * labelled from the facts, never from its own wording.
 *
 * Sections with nothing to say are left out. The message must stay under
 * WhatsApp's comfortable length (3500 characters, wa.ts clampMessage), so the
 * lists shrink in steps before anything gets cut mid-section.
 */

const MAX_LENGTH = 3500;

/** How many lines each list may show; later levels are used only when the message would otherwise be too long. */
interface Density {
  prioritas: number;
  hambatan: number;
  overdue: number;
  due: number;
  starting: number;
  changes: number;
  flags: number;
  quiet: number;
}

const DENSITIES: readonly Density[] = [
  { prioritas: 3, hambatan: 4, overdue: 6, due: 4, starting: 3, changes: 6, flags: 5, quiet: 8 },
  { prioritas: 3, hambatan: 3, overdue: 4, due: 3, starting: 3, changes: 4, flags: 4, quiet: 6 },
  { prioritas: 2, hambatan: 2, overdue: 3, due: 2, starting: 2, changes: 3, flags: 3, quiet: 4 },
  { prioritas: 1, hambatan: 1, overdue: 2, due: 1, starting: 1, changes: 2, flags: 2, quiet: 3 },
];

const STATUS_ORDER = ["selesai", "berjalan", "belum mulai", "blocked", "menunggu input"];

/** A member with a long list of in-window steps would otherwise take a whole line of ids. */
const URGENT_IDS_SHOWN = 5;

const FLAG_LABELS: Record<string, (f: BriefFlag, ref: string) => string> = {
  other_pic: (f, ref) => `${f.member} melapor${ref} yang PIC-nya orang lain`,
  done_vs_plan: (f, ref) => `${f.member} lapor selesai${ref}, plan masih ${f.planStatus ?? "belum selesai"}`,
  blocked_vs_plan: (f, ref) => `${f.member} lapor terhambat${ref}, plan menunjukkan ${f.planStatus ?? "tanpa hambatan"}`,
  early_start: (f, ref) => `${f.member} sudah mengerjakan${ref} sebelum jadwal mulai`,
  dependency_open: (f, ref) => `${f.member} mengerjakan${ref} padahal dependensinya belum selesai`,
  no_urgent_work: (f) => {
    const ids = f.planIds ?? [];
    const shown = ids.slice(0, URGENT_IDS_SHOWN).map((id) => `[${id}]`).join(" ");
    const more = ids.length > URGENT_IDS_SHOWN ? ` +${ids.length - URGENT_IDS_SHOWN}` : "";
    return `${f.member} belum melaporkan task urgent-nya${ids.length > 0 ? ` (${shown}${more})` : ""}`;
  },
};

const ACTIVITY_MAX = 50;

/** The reported activity, one line, at most ACTIVITY_MAX characters, in quotes. */
function quotedActivity(activity: string | null): string | null {
  const oneLine = (activity ?? "").replace(/\s+/g, " ").trim().replace(/"/g, "'");
  if (oneLine === "") return null;
  return `"${oneLine.length > ACTIVITY_MAX ? `${oneLine.slice(0, ACTIVITY_MAX - 1).trimEnd()}…` : oneLine}"`;
}

/**
 * One open flag as a line: the kind's own sentence plus, where it helps, the
 * reported activity in a short quote. The producer's note is NOT printed: it
 * restates the sentence ("Dilaporkan selesai oleh X, tapi status di plan masih
 * …") and only adds length.
 */
export function flagLine(flag: BriefFlag): string {
  const quote = quotedActivity(flag.activity);
  if (flag.kind === "low_confidence") {
    const what = flag.planRef ? `mungkin [${planIdOf(flag.planRef)}], menunggu jawaban` : "kurang jelas, menunggu jawaban";
    return `Laporan ${flag.member}${quote ? ` ${quote}` : ""} — ${what}`;
  }
  const ref = flag.planRef ? ` [${planIdOf(flag.planRef)}]` : "";
  const label = FLAG_LABELS[flag.kind];
  const base = label ? label(flag, ref) : `${flag.member}${ref}: ${flag.kind.replace(/_/g, " ")}`;
  // no_urgent_work is about what was NOT reported; the quoted activity would be an unrelated line.
  return quote && flag.kind !== "no_urgent_work" ? `${base} — ${quote}` : base;
}

/** The model repeats the PIC after the advice even when the advice already starts with their name. */
function picSuffix(saran: string, pic: string | undefined): string {
  if (!pic) return "";
  const names = pic.split(/\s*,\s*/);
  const lower = saran.trim().toLowerCase();
  return names.some((n) => lower.startsWith(n.toLowerCase())) ? "" : ` (${pic})`;
}

const picText = (pic: readonly string[]): string => (pic.length > 0 ? pic.join(", ") : "tanpa PIC");
const stepText = (item: BriefPlanRef): string => `[${item.id}] ${item.title}`;

/**
 * One step's changes as a line. A step whose IDENTITY changed (renumbered,
 * added, removed, back again) names itself, because after the supervisor
 * reuses IDs "[5.03] dihapus" alone says nothing:
 *   [5.03] → [5.04] QC dan pemasangan kedua box…
 *   [5.03] Wiring box PSU mobil aerolift drone 2 — langkah baru ditambahkan
 *   [5.05] Wiring box daya mobil aerolift drone 2 — dihapus dari plan
 * Ordinary field changes keep the short "[id] status · progress" form.
 */
export function planChangeLine(group: BriefPlanChangeGroup): string {
  const renumbered = group.changes.find((c) => c.field === "renumbered");
  const identity = group.changes.some((c) => ["renumbered", "added", "removed", "reappeared"].includes(c.field));
  // The head already shows the step's current text, so a "judul diubah" line for the same step is noise.
  const rest = group.changes.filter((c) => c.field !== "renumbered" && !(identity && c.field === "title")).map((c) => c.text);
  const title = group.title ? ` ${group.title}` : "";
  if (renumbered) {
    const oldId = group.oldId ?? renumbered.oldValue ?? "?";
    const head = `[${oldId}] → [${group.id}]${title}`;
    return rest.length > 0 ? `${head} — ${rest.join(" · ")}` : head;
  }
  if (identity) return `[${group.id}]${title} — ${rest.join(" · ")}`;
  return `[${group.id}] ${rest.join(" · ")}`;
}

function sinceHeading(facts: MorningBriefFacts): string {
  const sinceDay: CalendarDay = calendarDayOf(new Date(facts.since));
  const [year, month, day] = facts.today.split("-").map(Number) as [number, number, number];
  const gap = calendarDayDiff({ year, month, day }, sinceDay);
  return gap === 1 ? "Perubahan plan sejak kemarin" : `Perubahan plan sejak ${dayLabel(sinceDay)}`;
}

/** The plan's status words as the division says them; anything unknown is shown as written, lowercased. */
const STATUS_LABELS: Record<string, string> = {
  selesai: "selesai",
  berjalan: "berjalan",
  "belum mulai": "belum mulai",
  blocked: "terhambat",
  "menunggu input": "menunggu input",
};

function statusCountsLine(counts: Record<string, number>): string {
  const rank = (key: string) => {
    const i = STATUS_ORDER.indexOf(key.toLowerCase());
    return i === -1 ? STATUS_ORDER.length : i;
  };
  const entries = Object.entries(counts).sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  return countsLine(entries.map(([key, n]) => [n, STATUS_LABELS[key.trim().toLowerCase()] ?? key.toLowerCase()] as const));
}

/** Raw blockers, used when the model gave no suggestions: what is stuck, who said so, no advice. */
function rawBlockerLines(facts: MorningBriefFacts): string[] {
  const lines: string[] = [];
  const covered = new Set<string>();
  const reportLine = (b: BriefReportBlocker): string => {
    const problem = b.obstacle ?? `${b.activity} (ditandai terhambat)`;
    const category = b.category && b.category !== "other" ? `, ${obstacleCategoryLabel(b.category)}` : "";
    const ref = b.planRef ? `[${planIdOf(b.planRef)}] ` : "";
    return `⚠️ ${ref}${problem} (${b.member}${category})`;
  };
  for (const b of facts.blockers.fromReports) {
    lines.push(reportLine(b));
    if (b.planRef) covered.add(b.planRef);
  }
  for (const p of facts.blockers.planBlocked) {
    if (covered.has(p.planRef)) continue;
    covered.add(p.planRef);
    const why = p.risk ?? p.dependsOn ?? p.note;
    lines.push(`⚠️ ${stepText(p)} — status plan Blocked${why ? `: ${why}` : ""} (${picText(p.pic)})`);
  }
  for (const r of facts.blockers.riskDueSoon) {
    if (covered.has(r.planRef)) continue;
    lines.push(`${stepText(r)} — risiko: ${r.risk} (${picText(r.pic)})`);
  }
  return lines;
}

function renderAtDensity(facts: MorningBriefFacts, llm: BriefLlmOutput | null, d: Density): string {
  const plan = facts.plan;
  const labelOf = (planRef: string): string => plan?.labels[planRef] ?? "";

  // --- head: project, progress, status counts, the model's summary -------------
  const head = plan
    ? [
        `${bold(plan.projectName)} — progress ${plan.overallProgressPct}%`,
        statusCountsLine(plan.statusCounts),
        llm?.ringkasan ? llm.ringkasan : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n")
    : llm?.ringkasan || "";

  // --- the model's priorities and obstacle advice --------------------------------
  const prioritas =
    llm && llm.prioritas.length > 0
      ? section(
          "Prioritas hari ini",
          bulletList(
            llm.prioritas.map((p) => {
              const title = labelOf(p.planRef);
              return `[${planIdOf(p.planRef)}]${title ? ` ${title}` : ""} — ${p.alasan}`;
            }),
            { max: d.prioritas },
          ),
        )
      : null;

  const adviceLines =
    llm && llm.hambatan.length > 0
      ? llm.hambatan.map((h) => {
          const ref = h.planRef ? `[${planIdOf(h.planRef)}] ` : "";
          return `⚠️ ${ref}${h.masalah} → ${h.saran}${picSuffix(h.saran, h.pic)}`;
        })
      : rawBlockerLines(facts);
  const hambatan = adviceLines.length > 0 ? section("Hambatan & saran", bulletList(adviceLines, { max: d.hambatan })) : null;

  // --- deterministic plan lists ----------------------------------------------------
  const overdue =
    plan && plan.overdue.length > 0
      ? section(
          `Terlambat (${plan.overdue.length})`,
          bulletList(
            plan.overdue.map((o) => `⚠️ ${stepText(o)} — ${picText(o.pic)} · terlambat ${o.daysLate} hari`),
            { max: d.overdue },
          ),
        )
      : null;
  const dueLines = (items: readonly BriefDueItem[]) => bulletList(items.map((i) => `${stepText(i)} — ${picText(i.pic)}`), { max: d.due });
  const dueToday = plan && plan.dueToday.length > 0 ? section(`Jatuh tempo hari ini (${plan.dueToday.length})`, dueLines(plan.dueToday)) : null;
  const dueTomorrow = plan && plan.dueTomorrow.length > 0 ? section(`Jatuh tempo besok (${plan.dueTomorrow.length})`, dueLines(plan.dueTomorrow)) : null;
  const starting =
    plan && plan.startingToday.length > 0
      ? section(
          `Mulai hari ini (${plan.startingToday.length})`,
          bulletList(plan.startingToday.map((i) => `${stepText(i)} — ${picText(i.pic)}`), { max: d.starting }),
        )
      : null;

  // --- changes, flags, quiet --------------------------------------------------------
  const changes =
    facts.planChanges.length > 0
      ? section(
          sinceHeading(facts),
          bulletList(
            facts.planChanges.map(planChangeLine),
            { max: d.changes },
          ),
        )
      : null;

  const flags = facts.flags.length > 0 ? section("Perlu dicek", bulletList(facts.flags.map(flagLine), { max: d.flags })) : null;

  let quiet: string | null = null;
  if (facts.quiet.length > 0) {
    const entries = facts.quiet.slice(0, d.quiet).map((q) => `[${q.id}] ${picText(q.pic)}`);
    const rest = facts.quiet.length - entries.length;
    const rows: string[] = [];
    for (let i = 0; i < entries.length; i += 4) rows.push(entries.slice(i, i + 4).join(" · "));
    if (rest > 0) rows.push(`+${rest} lainnya`);
    quiet = section(`Belum ada laporan (${facts.quiet.length})`, rows.map((r) => `• ${r}`));
  }

  // --- everything that is not the plan ------------------------------------------------
  const g = facts.general;
  const otherLines: string[] = [];
  if (g.active + g.overdue + g.dueToday + g.blocked > 0) {
    otherLines.push(
      `Task lain: ${countsLine([
        [g.active, "aktif"],
        [g.overdue, "terlambat"],
        [g.dueToday, "jatuh tempo hari ini"],
        [g.blocked, "terhambat"],
      ])}`,
    );
  }
  if (g.completedYesterday > 0) otherLines.push(`${g.completedYesterday} task lain selesai kemarin`);
  if (g.onLeaveToday.length > 0) otherLines.push(`Izin/cuti/sakit hari ini: ${g.onLeaveToday.join(", ")}`);
  const other = otherLines.length > 0 ? section("Lainnya", bulletList(otherLines)) : null;

  return joinBlocks(
    titleLine("☀️", "Rangkuman Pagi", dayLabel(facts.today)),
    head,
    prioritas,
    hambatan,
    overdue,
    dueToday,
    dueTomorrow,
    starting,
    changes,
    flags,
    quiet,
    other,
  );
}

/**
 * Renders the brief. `llm` is null when the model was not asked, failed, or
 * returned nothing usable: the message then carries raw blockers without
 * advice and no priorities.
 */
export function renderMorningBrief(facts: MorningBriefFacts, llm: BriefLlmOutput | null): string {
  let text = "";
  for (const density of DENSITIES) {
    text = renderAtDensity(facts, llm, density);
    if (text.length <= MAX_LENGTH) return text;
  }
  return clampMessage(text, MAX_LENGTH);
}
