import type { AppDatabase } from "../db/types.ts";
import { resolveMembersByNameOrAlias } from "../members/service.ts";
import { resolveProjectsByNameOrAlias } from "../projects/service.ts";
import { addCalendarDays, calendarDayOf, type CalendarDay } from "../shared/time.ts";
import type { ExtractedActionItem } from "../llm/minutes-schema.ts";

/**
 * The deterministic half of meeting-minutes intake. The LLM reads prose;
 * everything that decides WHO and WHEN happens here, in plain code —
 * MASTER_SPEC.md §3.6 puts identity and deadline calculation among the
 * decisions never delegated to a model.
 *
 * Nothing here throws on ambiguity. Every unresolved name or date is
 * reported back so the bot can tell the admin exactly what it could not
 * work out, while the task is still created — losing a whole action item
 * because one name was misspelled would be the worse outcome.
 */

export interface ResolvedActionItem {
  title: string;
  notes: string | null;
  assigneeMemberIds: string[];
  /** The label exactly as written in the minutes, preserved for display (§7 stores both label and computed date). */
  deadlineLabel: string | null;
  deadlineDay: CalendarDay | null;
  projectId: string | null;
  /** What could NOT be worked out, phrased for the reply to the admin. */
  unresolved: string[];
}

/**
 * Indonesian date expressions that appear in real minutes. Deliberately
 * SMALL: only forms whose meaning is unambiguous. Anything else is left
 * unresolved and reported rather than guessed — §7 makes "deadline
 * tanggal 10" mean "finish before the 10th", so a wrong guess is not
 * merely imprecise, it is actively misleading about when work is late.
 */
export function resolveDeadlineText(text: string, today: CalendarDay): CalendarDay | null {
  const t = text.toLowerCase().trim();

  if (/\bhari ini\b/.test(t)) return today;
  if (/\bbesok\b/.test(t)) return addCalendarDays(today, 1);
  if (/\blusa\b/.test(t)) return addCalendarDays(today, 2);
  if (/\bminggu depan\b/.test(t)) return addCalendarDays(today, 7);

  // "tanggal 10" / "tgl 10" -> the 10th of this month, or next month if
  // that day has already passed.
  const dayOfMonth = /\b(?:tanggal|tgl)\.?\s*(\d{1,2})\b/.exec(t);
  if (dayOfMonth?.[1]) {
    const day = Number(dayOfMonth[1]);
    if (day >= 1 && day <= 31) {
      if (day >= today.day) return { year: today.year, month: today.month, day };
      return today.month === 12
        ? { year: today.year + 1, month: 1, day }
        : { year: today.year, month: today.month + 1, day };
    }
  }

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso?.[1] && iso[2] && iso[3]) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  return null;
}

export async function resolveActionItem(
  db: AppDatabase,
  item: ExtractedActionItem,
  now: Date,
): Promise<ResolvedActionItem> {
  const today = calendarDayOf(now);
  const unresolved: string[] = [];

  const assigneeMemberIds: string[] = [];
  for (const rawName of item.assigneeNames ?? []) {
    const name = rawName.trim();
    if (!name) continue;
    const matches = await resolveMembersByNameOrAlias(db, name);
    if (matches.length === 1 && matches[0]) {
      assigneeMemberIds.push(matches[0].memberId);
    } else {
      unresolved.push(
        matches.length === 0 ? `nama "${name}" tidak dikenal` : `nama "${name}" ambigu (${matches.length} cocok)`,
      );
    }
  }

  let deadlineDay: CalendarDay | null = null;
  const deadlineLabel = item.deadlineText?.trim() || null;
  if (deadlineLabel) {
    deadlineDay = resolveDeadlineText(deadlineLabel, today);
    if (!deadlineDay) unresolved.push(`deadline "${deadlineLabel}" tidak bisa ditentukan tanggalnya`);
  }

  let projectId: string | null = null;
  const projectText = item.projectText?.trim();
  if (projectText) {
    const matches = await resolveProjectsByNameOrAlias(db, projectText);
    if (matches.length === 1 && matches[0]) projectId = matches[0].projectId;
    else unresolved.push(matches.length === 0 ? `project "${projectText}" tidak dikenal` : `project "${projectText}" ambigu`);
  }

  return {
    title: item.title.trim(),
    notes: item.notes?.trim() || null,
    assigneeMemberIds,
    deadlineLabel,
    deadlineDay,
    projectId,
    unresolved,
  };
}
