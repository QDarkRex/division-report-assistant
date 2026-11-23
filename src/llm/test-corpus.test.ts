import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageClassificationSchema } from "./schemas.ts";
import { hasReportHeader } from "../reports/header.ts";
import { ALL_CORPUS_MESSAGES, NOISE_MESSAGES, QUERY_MESSAGES, REPORT_MESSAGES } from "./test-corpus.ts";

test("every corpus message has a category the Zod contract actually accepts", () => {
  for (const message of ALL_CORPUS_MESSAGES) {
    const result = MessageClassificationSchema.safeParse({ category: message.expectedCategory });
    assert.equal(result.success, true, `"${message.text}" has an invalid expectedCategory: ${message.expectedCategory}`);
  }
});

test("no duplicate message text in the corpus", () => {
  const seen = new Set<string>();
  for (const message of ALL_CORPUS_MESSAGES) {
    assert.equal(seen.has(message.text), false, `duplicate corpus entry: "${message.text}"`);
    seen.add(message.text);
  }
});

// Cross-checks the corpus against the actual deterministic pre-filter used by the pipeline —
// every report-labeled message must actually pass the header check the pipeline relies on,
// or the corpus would be testing a scenario the real code never routes as a report.
test("every daily_report corpus message actually has a valid report header", () => {
  for (const message of REPORT_MESSAGES) {
    assert.equal(hasReportHeader(message.text), true, `report corpus message missing a header: "${message.text}"`);
  }
});

test("query and noise corpus messages do not have a report header (they'd be mis-routed if they did)", () => {
  for (const message of [...QUERY_MESSAGES, ...NOISE_MESSAGES]) {
    assert.equal(hasReportHeader(message.text), false, `non-report message unexpectedly has a report header: "${message.text}"`);
  }
});

test("the corpus covers every classification category at least once", () => {
  const categories = new Set(ALL_CORPUS_MESSAGES.map((m) => m.expectedCategory));
  for (const category of ["daily_report", "query", "noise", "command", "clarification_response"] as const) {
    assert.ok(categories.has(category), `no corpus example for category "${category}"`);
  }
});
