import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { llmInvocations } from "../db/schema.ts";
import { fromJakartaWallClock } from "../shared/time.ts";
import {
  classifyBudgetStatus,
  getCurrentBudgetStatus,
  getMonthToDateSpendUsd,
  isLlmCallAllowed,
  isThinkingModeAllowed,
  maxTaskCandidatesFor,
} from "./budget.ts";

const thresholds = { softLimitUsd: 1, hardLimitUsd: 2 };

// MASTER_SPEC.md §4.4
test("classifyBudgetStatus buckets normal/soft/hard correctly", () => {
  assert.equal(classifyBudgetStatus(0.5, thresholds), "normal");
  assert.equal(classifyBudgetStatus(1, thresholds), "soft_limit");
  assert.equal(classifyBudgetStatus(1.99, thresholds), "soft_limit");
  assert.equal(classifyBudgetStatus(2, thresholds), "hard_limit");
});

test("thinking mode is only allowed under normal status — soft limit disables it", () => {
  assert.equal(isThinkingModeAllowed("normal"), true);
  assert.equal(isThinkingModeAllowed("soft_limit"), false);
  assert.equal(isThinkingModeAllowed("hard_limit"), false);
});

test("soft limit reduces task candidates sent to the model", () => {
  assert.equal(maxTaskCandidatesFor("normal"), 5);
  assert.equal(maxTaskCandidatesFor("soft_limit"), 3);
});

test("hard limit still allows report extraction — report ingestion must never silently stop", () => {
  assert.equal(isLlmCallAllowed("hard_limit", "report_extraction"), true);
  assert.equal(isLlmCallAllowed("hard_limit", "clarification"), true);
  assert.equal(isLlmCallAllowed("hard_limit", "scheduled_summary"), true);
});

test("hard limit cuts message classification and query intent — those degrade to deterministic handling", () => {
  assert.equal(isLlmCallAllowed("hard_limit", "message_classification"), false);
  assert.equal(isLlmCallAllowed("hard_limit", "query_intent"), false);
});

test("soft limit still allows every feature — only the mode (thinking, candidate count) changes", () => {
  for (const feature of ["message_classification", "report_extraction", "query_intent", "clarification", "scheduled_summary"] as const) {
    assert.equal(isLlmCallAllowed("soft_limit", feature), true);
  }
});

test("getMonthToDateSpendUsd sums only invocations within the current Jakarta month", async () => {
  const db = await createTestDb();
  const now = fromJakartaWallClock(2026, 8, 15, 10, 0);

  await db.insert(llmInvocations).values([
    {
      feature: "report_extraction",
      model: "deepseek-v4-flash",
      promptTokens: 1000,
      completionTokens: 200,
      estimatedCostUsd: "0.30",
      createdAt: fromJakartaWallClock(2026, 8, 1, 10, 0), // this month
    },
    {
      feature: "report_extraction",
      model: "deepseek-v4-flash",
      promptTokens: 1000,
      completionTokens: 200,
      estimatedCostUsd: "0.25",
      createdAt: fromJakartaWallClock(2026, 8, 30, 10, 0), // this month
    },
    {
      feature: "report_extraction",
      model: "deepseek-v4-flash",
      promptTokens: 1000,
      completionTokens: 200,
      estimatedCostUsd: "0.99",
      createdAt: fromJakartaWallClock(2026, 7, 31, 23, 59), // previous month
    },
    {
      feature: "report_extraction",
      model: "deepseek-v4-flash",
      promptTokens: 1000,
      completionTokens: 200,
      estimatedCostUsd: "0.99",
      createdAt: fromJakartaWallClock(2026, 9, 1, 0, 0), // next month
    },
  ]);

  const spend = await getMonthToDateSpendUsd(db, now);
  assert.ok(Math.abs(spend - 0.55) < 1e-9);
});

test("getCurrentBudgetStatus reflects real spend recorded via llm_invocations", async () => {
  const db = await createTestDb();
  const now = fromJakartaWallClock(2026, 8, 15, 10, 0);

  await db.insert(llmInvocations).values({
    feature: "report_extraction",
    model: "deepseek-v4-flash",
    promptTokens: 1000,
    completionTokens: 200,
    estimatedCostUsd: "2.10",
    createdAt: fromJakartaWallClock(2026, 8, 5, 10, 0),
  });

  const status = await getCurrentBudgetStatus(db, now, thresholds);
  assert.equal(status, "hard_limit");
});
