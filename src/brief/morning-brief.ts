import type { AppDatabase } from "../db/types.ts";
import { dailySummaries } from "../db/schema.ts";
import { calendarDayOf, formatCalendarDay } from "../shared/time.ts";
import { buildMorningBriefFacts, type MorningBriefFacts } from "./facts.ts";
import { requestBriefInsights, type BriefLlmDeps, type BriefLlmOutput } from "./llm.ts";
import { renderMorningBrief } from "./render.ts";

/**
 * Facts -> LLM -> text, in one place, so the 08:00 job and the preview script
 * (src/scripts/preview-morning-brief.ts) cannot drift apart.
 */

export interface MorningBrief {
  facts: MorningBriefFacts;
  /** Validated model output; null when the model was not asked, failed, or had nothing usable. */
  llm: BriefLlmOutput | null;
  /** Why `llm` is null after an attempt that failed; null otherwise. */
  llmError: string | null;
  text: string;
}

/**
 * Builds the brief for `now`. A model failure of any kind — gateway down,
 * timeout, output that never validates — is logged and the brief is rendered
 * without the model's sections: the group still gets the facts at 08:00.
 * Only a failure to read the database throws.
 */
export async function composeMorningBrief(
  db: AppDatabase,
  deps: { llm?: BriefLlmDeps },
  now: Date = new Date(),
  options: { since?: Date } = {},
): Promise<MorningBrief> {
  const facts = await buildMorningBriefFacts(db, now, options);

  let llm: BriefLlmOutput | null = null;
  let llmError: string | null = null;
  if (deps.llm) {
    try {
      llm = await requestBriefInsights(db, deps.llm, facts, now);
    } catch (error) {
      llmError = error instanceof Error ? error.message : String(error);
      console.error("morning-brief: LLM step failed, sending the brief without it:", llmError);
    }
  }

  return { facts, llm, llmError, text: renderMorningBrief(facts, llm) };
}

/**
 * Keeps the brief in daily_summaries (one row per Jakarta day, so a pg-boss
 * retry overwrites rather than duplicates). Its sentAt is what the next
 * brief's "changes since the previous brief" window starts from.
 */
export async function persistMorningBrief(db: AppDatabase, brief: MorningBrief, sentAt: Date): Promise<void> {
  const content = { kind: "morning_brief", version: 1, facts: brief.facts, llm: brief.llm, llmError: brief.llmError, text: brief.text };
  await db
    .insert(dailySummaries)
    .values({ summaryDay: formatCalendarDay(calendarDayOf(sentAt)), content, sentAt })
    .onConflictDoUpdate({ target: dailySummaries.summaryDay, set: { content, sentAt } });
}
