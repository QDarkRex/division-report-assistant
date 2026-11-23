import { eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { reportItems, weeklyRecaps, weeklyStreamRecaps, workStreams } from "../db/schema.ts";
import { calendarDayOf, mondayOf, type CalendarDay } from "../shared/time.ts";
import type { BriefLlmDeps } from "../brief/llm.ts";
import { buildWeeklyRecapFacts, type WeeklyRecapFacts } from "./facts.ts";
import { clip, requestRecapPlan, type RecapPlan } from "./llm.ts";
import { buildRecapView, renderFallbackRecap, renderWeeklyRecap, type RecapView } from "./render.ts";

/**
 * Facts -> one LLM call -> validated plan -> text, in one place so the Sunday
 * job and the preview script (src/scripts/preview-weekly-recap.ts) cannot
 * drift apart. A model failure of any kind sends the deterministic fallback
 * instead: the group never gets nothing silently.
 */

export interface WeeklyRecap {
  facts: WeeklyRecapFacts;
  /** Validated model output; null when the model was not asked, failed, or there was nothing to summarise. */
  plan: RecapPlan | null;
  view: RecapView | null;
  /** Why the fallback was used; null when the model's recap was. */
  llmError: string | null;
  text: string;
}

/** The Monday of the week containing `now` (Jakarta). On Sunday 19:00 that is the week just ending. */
export function recapWeekStartFor(now: Date): CalendarDay {
  return mondayOf(calendarDayOf(now));
}

export async function composeWeeklyRecap(
  db: AppDatabase,
  deps: { llm?: BriefLlmDeps },
  weekStart: CalendarDay,
  now: Date = new Date(),
): Promise<WeeklyRecap> {
  const facts = await buildWeeklyRecapFacts(db, weekStart);

  let llmError: string | null = null;
  if (facts.items.length === 0) llmError = "tidak ada butir laporan pekan ini";
  else if (!deps.llm) llmError = "LLM tidak dikonfigurasi";
  else {
    try {
      const plan = await requestRecapPlan(db, deps.llm, facts, now);
      const view = buildRecapView(facts, plan);
      return { facts, plan, view, llmError: null, text: renderWeeklyRecap(view) };
    } catch (error) {
      llmError = error instanceof Error ? error.message : String(error);
      console.error("weekly-recap: LLM step failed, sending the deterministic fallback:", llmError);
    }
  }
  return { facts, plan: null, view: null, llmError, text: renderFallbackRecap(facts) };
}

/** Why this recap must not be stored as the week's result (a fallback has no assignments), or null when it may be. */
export function persistRefusal(recap: WeeklyRecap): string | null {
  return recap.llmError === null ? null : `the LLM step did not succeed (${recap.llmError}); nothing persisted`;
}

const OBSTACLE_CHARS = 300;

/**
 * Stores the week: new streams, each item's stream, one weekly_stream_recaps
 * row per stream and the rendered message. Idempotent per week (a retry or a
 * re-run overwrites). Without a plan (fallback) only the message is stored.
 */
export async function persistWeeklyRecap(db: AppDatabase, recap: WeeklyRecap, sentAt: Date | null): Promise<void> {
  const { facts, plan, view } = recap;
  if (plan && view) {
    if (plan.newStreams.length > 0) {
      await db
        .insert(workStreams)
        .values(plan.newStreams.map((s) => ({ streamId: s.streamId, name: s.name, shortName: s.shortName, origin: s.streamId === "lain-lain" ? "seed" : "llm" })))
        .onConflictDoNothing();
    }

    const byStream = new Map<string, string[]>();
    for (const item of facts.items) {
      const id = plan.assignment.get(item.alias)!;
      byStream.set(id, [...(byStream.get(id) ?? []), item.itemId]);
    }
    for (const [streamId, itemIds] of byStream) {
      await db.update(reportItems).set({ workStreamId: streamId }).where(inArray(reportItems.itemId, itemIds));
    }

    await db.delete(weeklyStreamRecaps).where(eq(weeklyStreamRecaps.weekStart, facts.weekStart));
    const itemsById = new Map(facts.items.map((i) => [i.itemId, i]));
    const rows = view.streams.map((s) => {
      const items = (byStream.get(s.streamId) ?? []).map((id) => itemsById.get(id)!);
      const obstacles = [...new Set(items.filter((i) => i.obstacle || i.status === "blocked").map((i) => clip(i.obstacle ?? i.activity, 120)))].join("; ");
      return {
        weekStart: facts.weekStart,
        streamId: s.streamId,
        itemCount: s.itemCount,
        members: s.members
          .map((m) => `${m} ${items.filter((i) => i.member === m).length}`)
          .join(", "),
        bullets: s.bullets.map((b) => ({ text: b.text, label: b.label, evidenceItemIds: b.evidenceItemIds })),
        blockedCount: s.blockedCount,
        obstacles: clip(obstacles, OBSTACLE_CHARS),
        prevItemCount: s.prevCount,
      };
    });
    if (rows.length > 0) await db.insert(weeklyStreamRecaps).values(rows);
  }

  // A backfill (sentAt null) must not erase the time of a real send.
  const values = { text: recap.text, llmOk: recap.llmError === null, ...(sentAt ? { sentAt } : {}) };
  await db
    .insert(weeklyRecaps)
    .values({ weekStart: facts.weekStart, sentAt, ...values })
    .onConflictDoUpdate({ target: weeklyRecaps.weekStart, set: values });
}
