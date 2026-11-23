import type { AppDatabase } from "../db/types.ts";
import { llmInvocations } from "../db/schema.ts";
import type { LlmFeature } from "./budget.ts";

/**
 * DeepSeek V4 Flash pricing per ADR-0010 (verified 2026-08-06):
 * cache-hit input $0.0028/1M, cache-miss input $0.14/1M, output $0.28/1M.
 * LiteLLM's usage response doesn't distinguish cache-hit vs cache-miss
 * input tokens in the standard `usage` object, so this estimates using the
 * cache-miss (worst-case) rate — consistent with the ADR addendum's
 * decision to plan around the pessimistic estimate rather than assume the
 * best case. Actual per-call cost, once LiteLLM exposes it directly
 * (`usage.cost` in some configurations), should be preferred over this
 * estimate when available.
 */
const CACHE_MISS_INPUT_USD_PER_TOKEN = 0.14 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 0.28 / 1_000_000;

export function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  return promptTokens * CACHE_MISS_INPUT_USD_PER_TOKEN + completionTokens * OUTPUT_USD_PER_TOKEN;
}

export interface RecordInvocationInput {
  feature: LlmFeature;
  model: string;
  thinkingMode: boolean;
  promptTokens: number;
  completionTokens: number;
  retryCount: number;
  estimatedCostUsd?: number;
  /** Omit (or null) when the call succeeded. */
  failureReason?: string | null;
}

/** §4.5 item 10 / ADR-0010 mitigation #3: every LLM call is recorded for audit and budget tracking. */
export async function recordInvocation(db: AppDatabase, input: RecordInvocationInput): Promise<void> {
  const cost = input.estimatedCostUsd ?? estimateCostUsd(input.promptTokens, input.completionTokens);
  await db.insert(llmInvocations).values({
    feature: input.feature,
    model: input.model,
    thinkingMode: input.thinkingMode,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    retryCount: input.retryCount,
    estimatedCostUsd: cost.toFixed(8),
    failureReason: input.failureReason ?? null,
  });
}

/**
 * Records a call that never produced valid output. Separate from
 * recordInvocation only to keep the failure path's intent obvious at the
 * call site — a failed call still costs real tokens (see LlmCallError) and
 * must count against the same monthly budget the success path does.
 */
export async function recordFailedInvocation(
  db: AppDatabase,
  input: Omit<RecordInvocationInput, "failureReason"> & { failureReason: string },
): Promise<void> {
  await recordInvocation(db, input);
}
