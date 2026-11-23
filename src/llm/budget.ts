import { and, gte, lt, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { llmInvocations } from "../db/schema.ts";
import { calendarDayOf, fromJakartaWallClock } from "../shared/time.ts";

/**
 * MASTER_SPEC.md §4.4 degradation rules. Thresholds are USD, not the
 * ADR-0010/spec's IDR figures directly — the ADR itself flags IDR/USD
 * exchange-rate drift as a risk ("track actual USD cost, not IDR
 * approximation"), so the conversion is an operator-set default, not a
 * hardcoded rate. Override via env if the real rate moves.
 */
export interface BudgetThresholds {
  softLimitUsd: number;
  hardLimitUsd: number;
}

/** Rp15,000 / Rp25,000 monthly at a rough ~Rp16,000/US$1 default — see the doc comment above. */
export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  softLimitUsd: 0.94,
  hardLimitUsd: 1.56,
};

export type BudgetStatus = "normal" | "soft_limit" | "hard_limit";

export function classifyBudgetStatus(monthToDateSpendUsd: number, thresholds: BudgetThresholds = DEFAULT_BUDGET_THRESHOLDS): BudgetStatus {
  if (monthToDateSpendUsd >= thresholds.hardLimitUsd) return "hard_limit";
  if (monthToDateSpendUsd >= thresholds.softLimitUsd) return "soft_limit";
  return "normal";
}

export const LLM_FEATURES = [
  "message_classification",
  "report_extraction",
  "query_intent",
  "clarification",
  "scheduled_summary",
] as const;
export type LlmFeature = (typeof LLM_FEATURES)[number];

/**
 * §4.4 hard-limit rule: "allow LLM only for daily reports, explicit admin
 * instructions, required clarifications, scheduled summaries that cannot
 * be produced deterministically... process simple queries
 * deterministically." Message classification is also cut at hard limit —
 * report ingestion must not stop (§4.4: "never silently stop report
 * ingestion"), but its own deterministic pre-filter (hasReportHeader)
 * covers the "is this even a report" gate, so classification-for-nuance
 * can pause without blocking ingestion.
 */
const HARD_LIMIT_ALLOWED_FEATURES: readonly LlmFeature[] = ["report_extraction", "clarification", "scheduled_summary"];

export function isLlmCallAllowed(status: BudgetStatus, feature: LlmFeature): boolean {
  if (status === "hard_limit") return HARD_LIMIT_ALLOWED_FEATURES.includes(feature);
  return true;
}

/** §4.4 soft-limit rule: disable automatic thinking mode. Only "normal" status permits it. */
export function isThinkingModeAllowed(status: BudgetStatus): boolean {
  return status === "normal";
}

/** §4.4 soft-limit rule: "reduce task candidates sent to model." */
export function maxTaskCandidatesFor(status: BudgetStatus): number {
  return status === "normal" ? 5 : 3;
}

function startOfJakartaMonth(now: Date): Date {
  const { year, month } = calendarDayOf(now);
  return fromJakartaWallClock(year, month, 1, 0, 0, 0, 0);
}

function startOfNextJakartaMonth(now: Date): Date {
  const { year, month } = calendarDayOf(now);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return fromJakartaWallClock(nextYear, nextMonth, 1, 0, 0, 0, 0);
}

/** Sums llm_invocations.estimated_cost_usd for the current Jakarta calendar month. */
export async function getMonthToDateSpendUsd(db: AppDatabase, now: Date = new Date()): Promise<number> {
  const start = startOfJakartaMonth(now);
  const end = startOfNextJakartaMonth(now);

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${llmInvocations.estimatedCostUsd}), 0)` })
    .from(llmInvocations)
    .where(and(gte(llmInvocations.createdAt, start), lt(llmInvocations.createdAt, end)));

  return Number(row?.total ?? 0);
}

export async function getCurrentBudgetStatus(
  db: AppDatabase,
  now: Date = new Date(),
  thresholds: BudgetThresholds = DEFAULT_BUDGET_THRESHOLDS,
): Promise<BudgetStatus> {
  const spend = await getMonthToDateSpendUsd(db, now);
  return classifyBudgetStatus(spend, thresholds);
}
