import { calendarDayDiff, calendarDayOf, dayOfWeek, type CalendarDay } from "../shared/time.ts";
import { lastFinishDay } from "../tasks/deadline.ts";

/**
 * Small pure helpers for the messages the bot SENDS to WhatsApp, so every
 * formatter shares one look: an emoji and a bold title on the first line,
 * blank lines between sections, "• " bullets, Indonesian wording, and
 * dates as "Sab, 3 Okt" rather than ISO. No LLM, no I/O — these only
 * arrange text the callers already got from the database
 * (MASTER_SPEC.md §16).
 */

/** WhatsApp's own bold markup. */
export function bold(text: string): string {
  return `*${text}*`;
}

/** "• item" lines; anything past `max` collapses into one "• +N lainnya" so a long list cannot blow the message length. */
export function bulletList(items: readonly string[], { max = 8 }: { max?: number } = {}): string[] {
  const lines = items.slice(0, max).map((item) => `• ${item}`);
  if (items.length > max) lines.push(`• +${items.length - max} lainnya`);
  return lines;
}

/** A bold label followed by its lines. */
export function section(label: string, lines: readonly string[]): string {
  return [bold(label), ...lines].join("\n");
}

/** Blocks separated by exactly one blank line; empty blocks are dropped. */
export function joinBlocks(...blocks: ReadonlyArray<string | null | undefined | false>): string {
  return blocks.filter((b): b is string => typeof b === "string" && b.length > 0).join("\n\n");
}

/** The first line of a message: one emoji, a bold title, and optionally " — context". */
export function titleLine(emoji: string, title: string, context?: string): string {
  return `${emoji} ${bold(title)}${context ? ` — ${context}` : ""}`;
}

/** Counts on one line, "12 berjalan · 3 terhambat"; zero counts are omitted unless everything is zero. */
export function countsLine(counts: ReadonlyArray<readonly [number, string]>): string {
  const shown = counts.filter(([n]) => n > 0);
  return (shown.length > 0 ? shown : counts.slice(0, 1)).map(([n, label]) => `${n} ${label}`).join(" · ");
}

/**
 * Hard ceiling for one message. Lists are already capped by bulletList; this
 * is the backstop for a message that is long for another reason (many
 * sections), cutting at a line boundary rather than mid-word.
 */
export function clampMessage(text: string, max = 3500): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastBreak = cut.lastIndexOf("\n");
  return `${(lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n…`;
}

const WEEKDAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** "Sab, 3 Okt". A string is read as a leading YYYY-MM-DD; anything else is returned as given rather than guessed at. */
export function dayLabel(day: CalendarDay | string): string {
  let parsed: CalendarDay;
  if (typeof day === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
    if (!match) return day;
    parsed = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  } else {
    parsed = day;
  }
  const month = MONTHS[parsed.month - 1];
  if (!month) return typeof day === "string" ? day : `${parsed.year}-${parsed.month}-${parsed.day}`;
  return `${WEEKDAYS[dayOfWeek(parsed)]}, ${parsed.day} ${month}`;
}

/** How far off the deadline is, from the last day the task can still be finished (MASTER_SPEC.md §8). */
export function relativeDeadline(mustFinishBefore: Date, now: Date): string {
  const daysLeft = calendarDayDiff(lastFinishDay(mustFinishBefore), calendarDayOf(now));
  if (daysLeft < 0) return `terlambat ${-daysLeft} hari`;
  if (daysLeft === 0) return "hari ini";
  if (daysLeft === 1) return "besok";
  return `H-${daysLeft}`;
}

const STATUS_LABELS: Record<string, string> = {
  active: "Belum mulai",
  active_unreviewed: "Perlu ditinjau",
  in_progress: "Berjalan",
  blocked: "Terhambat",
  paused: "Ditunda",
  stale: "Macet",
  status_conflict: "Konflik status",
  done: "Selesai",
  cancelled: "Dibatalkan",
};

/** Indonesian name for a task status; an unknown value is shown as-is rather than hidden. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const REPORT_ITEM_STATUS_LABELS: Record<string, string> = {
  worked_on: "dikerjakan",
  in_progress: "berjalan",
  testing: "diuji",
  blocked: "terhambat",
  done: "selesai",
  unknown: "belum jelas",
};

/** Indonesian name for a report item's status (a different enum from the task one). */
export function reportItemStatusLabel(status: string): string {
  return REPORT_ITEM_STATUS_LABELS[status] ?? status;
}

const OBSTACLE_CATEGORY_LABELS: Record<string, string> = {
  waiting_material: "menunggu material",
  waiting_component: "menunggu komponen",
  waiting_information: "menunggu informasi",
  technical_issue: "masalah teknis",
  software_issue: "masalah software",
  hardware_issue: "masalah hardware",
  dependency: "bergantung pihak lain",
  resource_unavailable: "sumber daya tidak tersedia",
  needs_decision: "butuh keputusan",
  other: "lainnya",
};

/** Indonesian name for an obstacle category from the report-item classifier. */
export function obstacleCategoryLabel(category: string): string {
  return OBSTACLE_CATEGORY_LABELS[category] ?? category;
}

const MASTER_PLAN_PREFIX = "master-plan-";

/**
 * Master-plan imports carry titles shaped "<area>: <step>" and a
 * sourceReference "master-plan-<plan>:<id>"; in a chat list the id plus the
 * step is what people recognise, the area is noise. Anything else shows its
 * title. Cut to 70 characters so one long title cannot own the screen.
 */
export function taskLabel(task: { title: string; sourceReference?: string | null }): string {
  let label = task.title;
  const ref = task.sourceReference;
  if (ref?.startsWith(MASTER_PLAN_PREFIX)) {
    // A step that left the sheet keeps "…:5.03~removed-1a2b3c4d" (see mapping.ts
    // removedSourceReferenceFor): show its last ID, marked, never the suffix.
    const rest = ref.slice(ref.indexOf(":") + 1);
    const mark = rest.indexOf("~removed");
    const id = mark >= 0 ? rest.slice(0, mark) : rest;
    const split = task.title.indexOf(": ");
    if (ref.includes(":") && id.length > 0) {
      label = `[${id}${mark >= 0 ? " dihapus" : ""}] ${split >= 0 ? task.title.slice(split + 2) : task.title}`;
    }
  }
  return label.length > 70 ? `${label.slice(0, 69).trimEnd()}…` : label;
}
