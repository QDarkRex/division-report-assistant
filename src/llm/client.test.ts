import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { LlmCallError, callLlmForJson } from "./client.ts";

const schema = z.object({ category: z.enum(["daily_report", "noise"]) });

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

interface UsageFixture {
  prompt_tokens: number;
  completion_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
}

function chatCompletion(contentObj: unknown, usage: UsageFixture = { prompt_tokens: 100, completion_tokens: 20 }) {
  return { choices: [{ message: { content: JSON.stringify(contentObj) } }], usage };
}

test("valid JSON on the first try returns immediately with retryCount 0", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(chatCompletion({ category: "daily_report" }));
  };

  const result = await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
  );

  assert.equal(result.data.category, "daily_report");
  assert.equal(result.retryCount, 0);
  assert.equal(result.promptTokens, 100);
  assert.equal(result.completionTokens, 20);
  assert.equal(calls, 1);
});

test("invalid JSON triggers a bounded repair retry, then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return jsonResponse({ choices: [{ message: { content: "not json" } }] });
    return jsonResponse(chatCompletion({ category: "noise" }));
  };

  const result = await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
  );

  assert.equal(result.data.category, "noise");
  assert.equal(result.retryCount, 1);
  assert.equal(calls, 2);
});

test("a schema-mismatched response triggers a repair retry, then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return jsonResponse(chatCompletion({ category: "not_a_valid_category" }));
    return jsonResponse(chatCompletion({ category: "daily_report" }));
  };

  const result = await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
  );

  assert.equal(result.data.category, "daily_report");
  assert.equal(result.retryCount, 1);
});

// Roadmap Phase 2 exit criteria: "invalid JSON retry is bounded (max 3 attempts)"
test("retries are bounded — gives up after the configured max and never mutates anything", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({ choices: [{ message: { content: "still not json" } }] });
  };

  await assert.rejects(
    () =>
      callLlmForJson(
        { baseUrl: "http://litellm.test", fetchImpl },
        { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema, maxRepairAttempts: 3 },
      ),
    LlmCallError,
  );
  assert.equal(calls, 4, "1 initial attempt + 3 repair retries, never more");
});

test("maxRepairAttempts is configurable per call", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({ choices: [{ message: { content: "still not json" } }] });
  };

  await assert.rejects(() =>
    callLlmForJson(
      { baseUrl: "http://litellm.test", fetchImpl },
      { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema, maxRepairAttempts: 1 },
    ),
  );
  assert.equal(calls, 2);
});

// 400, not 500: since 2026-08-12 the transient statuses (408/429/5xx) are
// retried, so this asserts the non-retryable half of that split — a
// malformed request fails identically however often it is repeated, and
// retrying it would only delay telling the member.
test("a non-transient HTTP failure throws immediately without consuming repair attempts", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({ error: "bad request" }, { ok: false, status: 400 });
  };

  await assert.rejects(
    () =>
      callLlmForJson(
        { baseUrl: "http://litellm.test", fetchImpl },
        { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
      ),
    LlmCallError,
  );
  assert.equal(calls, 1);
});

// Live-verified 2026-08-07: deepseek-v4-flash reasons by default (16 reasoning
// tokens to answer "OK") unless extra_body.thinking.type is explicitly "disabled".
test("thinking mode defaults to disabled and is sent explicitly, not omitted", async () => {
  let sentBody: Record<string, unknown> | undefined;
  const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sentBody = JSON.parse(String(init?.body));
    return jsonResponse(chatCompletion({ category: "noise" }));
  };

  await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
  );

  assert.deepEqual(sentBody?.extra_body, { thinking: { type: "disabled" } });
});

test("thinking mode can be explicitly enabled", async () => {
  let sentBody: Record<string, unknown> | undefined;
  const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sentBody = JSON.parse(String(init?.body));
    return jsonResponse(chatCompletion({ category: "noise" }));
  };

  await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema, thinkingMode: true },
  );

  assert.deepEqual(sentBody?.extra_body, { thinking: { type: "enabled" } });
});

test("reasoning token usage is surfaced on the result when the provider reports it", async () => {
  const fetchImpl = async () =>
    jsonResponse(
      chatCompletion(
        { category: "noise" },
        { prompt_tokens: 91, completion_tokens: 18, completion_tokens_details: { reasoning_tokens: 16 } },
      ),
    );

  const result = await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
  );

  assert.equal(result.reasoningTokens, 16);
});

test("the repair prompt is appended to the conversation, not a fresh unrelated request", async () => {
  const seenMessageCounts: number[] = [];
  let calls = 0;
  const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++;
    const parsedBody = JSON.parse(String(init?.body));
    seenMessageCounts.push(parsedBody.messages.length);
    if (calls === 1) return jsonResponse({ choices: [{ message: { content: "not json" } }] });
    return jsonResponse(chatCompletion({ category: "noise" }));
  };

  await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
  );

  assert.deepEqual(seenMessageCounts, [2, 4], "second call carries the original exchange plus the repair prompt");
});

// Live evidence 2026-08-12: 2 of 3 recorded extraction failures were
// `http 408` gateway timeouts with zero tokens spent — nothing wrong with
// the report, the request simply never landed, and the member was told to
// resend for no reason.
test("a transient 408 is retried with the same request, not surfaced as a failure", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("upstream timeout", { status: 408 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await callLlmForJson(
    { baseUrl: "http://gateway", fetchImpl },
    { model: "m", systemPrompt: "s", userContent: "u", schema: z.object({ ok: z.boolean() }) },
  );
  assert.equal(calls, 2);
  assert.equal(result.data.ok, true);
  assert.equal(result.retryCount, 0, "a dropped request must not consume the model's repair budget");
});

test("a persistent 408 eventually fails, carrying the reason for telemetry", async () => {
  const fetchImpl = (async () => new Response("upstream timeout", { status: 408 })) as unknown as typeof fetch;

  await assert.rejects(
    callLlmForJson(
      { baseUrl: "http://gateway", fetchImpl },
      { model: "m", systemPrompt: "s", userContent: "u", schema: z.object({ ok: z.boolean() }) },
    ),
    (error: unknown) => error instanceof LlmCallError && error.detail.lastFailureReason === "http 408",
  );
});

// Found 2026-08-29: the repair prompt sent only Zod issue PATHS. A
// top-level .refine() has an empty path, so the model was told
// "did not match the required schema ()" — nothing actionable — and
// repeated the same rejected answer until the attempts ran out. Nine real
// reports failed recovery this way.
test("the repair prompt names WHAT was wrong, not just where", async () => {
  const refined = z
    .object({ items: z.array(z.string()).default([]) })
    .refine((v) => v.items.length > 0, { message: "items must not be empty" });

  const sentPrompts: string[] = [];
  let calls = 0;
  const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    sentPrompts.push(body.messages[body.messages.length - 1].content);
    if (calls === 1) return jsonResponse(chatCompletion({ items: [] }));
    return jsonResponse(chatCompletion({ items: ["ada isinya"] }));
  };

  await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema: refined },
  );

  const repairPrompt = sentPrompts[1] ?? "";
  assert.match(repairPrompt, /items must not be empty/, "the refine's own message must reach the model");
  assert.doesNotMatch(repairPrompt, /schema \(\)/, "must never send an empty parenthesised path list");
});

test("field-level issues still identify the field by name", async () => {
  const sentPrompts: string[] = [];
  let calls = 0;
  const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    sentPrompts.push(body.messages[body.messages.length - 1].content);
    if (calls === 1) return jsonResponse(chatCompletion({ category: "bukan_kategori" }));
    return jsonResponse(chatCompletion({ category: "noise" }));
  };

  await callLlmForJson(
    { baseUrl: "http://litellm.test", fetchImpl },
    { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "user", schema },
  );

  assert.match(sentPrompts[1] ?? "", /category/);
});
