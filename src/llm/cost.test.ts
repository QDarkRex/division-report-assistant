import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { getMonthToDateSpendUsd } from "./budget.ts";
import { estimateCostUsd, recordInvocation } from "./cost.ts";

test("estimateCostUsd uses the cache-miss (worst-case) input rate per ADR-0010", () => {
  const cost = estimateCostUsd(1000, 200);
  // 1000 * 0.14/1e6 + 200 * 0.28/1e6
  assert.ok(Math.abs(cost - (1000 * (0.14 / 1_000_000) + 200 * (0.28 / 1_000_000))) < 1e-12);
});

test("recordInvocation persists a row that getMonthToDateSpendUsd can sum", async () => {
  const db = await createTestDb();
  await recordInvocation(db, {
    feature: "report_extraction",
    model: "deepseek-v4-flash",
    thinkingMode: false,
    promptTokens: 1500,
    completionTokens: 300,
    retryCount: 0,
  });

  const spend = await getMonthToDateSpendUsd(db, new Date());
  assert.ok(spend > 0);
});
