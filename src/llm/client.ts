import type { z } from "zod";

/**
 * LiteLLM gateway client — OpenAI-compatible /chat/completions. Never
 * called directly by tasks/reports/members services (MASTER_SPEC.md §2
 * module dependency rule: "tasks/, reports/, members/ never import from
 * llm/"); this module's job ends at "validated data," the caller decides
 * what to do with it.
 */

export interface LlmClientConfig {
  baseUrl: string;
  apiKey?: string;
  /** Injectable for testing — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface LlmCallParams<T> {
  model: string;
  /** Byte-stable across calls for the same feature — ADR-0010 addendum's cache-hit-rate commitment. Callers must not interpolate per-call data into this. */
  systemPrompt: string;
  userContent: string;
  /**
   * Input side is `unknown` on purpose: what gets validated is
   * JSON.parse()'d model output. Writing `z.ZodType<T>` instead pins the
   * schema's input type to equal its output type, which silently breaks
   * inference for any schema using `.default()` — T resolves to the INPUT
   * shape (fields optional) and every consumer then has to null-check
   * fields the default guarantees are present.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxOutputTokens?: number;
  /** §4.5/roadmap: bounded retries, max 3 by default. */
  maxRepairAttempts?: number;
  /**
   * §3.6/§4.5 item 3: non-thinking by default. MUST be sent explicitly —
   * live-verified 2026-08-07 that deepseek-v4-flash reasons by default
   * (16 reasoning tokens to answer "OK") unless told otherwise via
   * `extra_body: {thinking: {type: "disabled"}}`. Omitting this parameter
   * is not "using the default," it's silently paying for reasoning on
   * every call. Default here: false (non-thinking).
   */
  thinkingMode?: boolean;
}

export interface LlmCallResult<T> {
  data: T;
  promptTokens: number;
  completionTokens: number;
  /** Subset of completionTokens spent on reasoning, when the provider reports it (e.g. DeepSeek). */
  reasoningTokens?: number;
  /** Number of repair attempts consumed (0 = succeeded on the first try). */
  retryCount: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

/** Request never landed / upstream was momentarily unavailable — retrying the SAME request is meaningful. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_BASE_MS = 500;

/** Injectable-free tiny sleep; unref'd timers aren't needed since this is always awaited inside a live request. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Carries what the failed call actually consumed. Found live 2026-08-10:
 * callers caught this with an empty `catch {}`, so an exhausted-repair
 * failure was invisible three ways at once — no log line, no
 * llm_invocations row, and (worst) the tokens burned across every failed
 * attempt were never counted against the monthly budget. A report that
 * fails costs MORE than one that succeeds (1 call + N repairs) while
 * recording as zero spend, which silently under-reports exactly the
 * traffic that most needs watching.
 */
export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly detail: {
      attempts: number;
      promptTokens: number;
      completionTokens: number;
      lastFailureReason: string;
    } = { attempts: 0, promptTokens: 0, completionTokens: 0, lastFailureReason: "unknown" },
  ) {
    super(message);
    this.name = "LlmCallError";
  }
}

/**
 * Calls the LLM and validates its JSON response against `schema`, retrying
 * with an explicit repair prompt (bounded) on invalid JSON or a schema
 * mismatch. Never mutates any state itself — MASTER_SPEC.md §2: "the LLM
 * must not directly mutate state."
 */
export async function callLlmForJson<T>(config: LlmClientConfig, params: LlmCallParams<T>): Promise<LlmCallResult<T>> {
  const fetchFn = config.fetchImpl ?? fetch;
  const maxAttempts = params.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;

  const messages: ChatMessage[] = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userContent },
  ];

  let lastFailureReason = "unknown";
  // Accumulated across every attempt, including the failed ones — see
  // LlmCallError's doc comment on why the failure path must report spend.
  let spentPromptTokens = 0;
  let spentCompletionTokens = 0;
  let transientRetries = 0;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: params.model,
        messages,
        response_format: { type: "json_object" },
        max_tokens: params.maxOutputTokens ?? 1024,
        extra_body: { thinking: { type: params.thinkingMode ? "enabled" : "disabled" } },
      }),
    });

    if (!response.ok) {
      // Transient upstream failures are retried rather than surfaced as a
      // lost report. Live evidence (2026-08-12): 2 of 3 recorded extraction
      // failures were `http 408` gateway timeouts with zero tokens spent —
      // nothing was wrong with the report or the prompt, the request simply
      // never landed, and the member was told to resend for no reason.
      // Only these statuses retry: a 400/401/422 would fail identically
      // however many times it is repeated.
      if (TRANSIENT_HTTP_STATUSES.has(response.status) && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        attempt--; // a dropped request is not a failed repair attempt — don't spend the model's repair budget on it
        await delay(TRANSIENT_RETRY_BASE_MS * transientRetries);
        continue;
      }
      throw new LlmCallError(`LLM call failed: ${response.status} ${await response.text()}`, {
        attempts: attempt + 1,
        promptTokens: spentPromptTokens,
        completionTokens: spentCompletionTokens,
        lastFailureReason: `http ${response.status}`,
      });
    }

    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content ?? "";
    const promptTokens = body.usage?.prompt_tokens ?? 0;
    const completionTokens = body.usage?.completion_tokens ?? 0;
    const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens;
    spentPromptTokens += promptTokens;
    spentCompletionTokens += completionTokens;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      lastFailureReason = "invalid JSON";
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: "Your last response was not valid JSON. Reply again with ONLY a single valid JSON object matching the required schema — no prose, no markdown fences.",
      });
      continue;
    }

    const validated = params.schema.safeParse(parsed);
    if (!validated.success) {
      lastFailureReason = validated.error.message;
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        // The MESSAGE, not just the path. A top-level .refine() has an
        // empty path, so a path-only prompt told the model literally
        // "did not match the required schema ()" — no information at all.
        // Found 2026-08-29 recovering emptied reports: 9 of them failed
        // all three repair attempts because the model was asked to fix an
        // unnamed problem and kept returning the same empty extraction.
        content: `Your last response did not match the required schema. Problems: ${validated.error.issues
          .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
          .join("; ")}. Reply again with ONLY a single valid JSON object matching the required schema.`,
      });
      continue;
    }

    return {
      data: validated.data,
      promptTokens,
      completionTokens,
      retryCount: attempt,
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    };
  }

  throw new LlmCallError(`LLM did not produce valid output after ${maxAttempts} repair attempts: ${lastFailureReason}`, {
    attempts: maxAttempts + 1,
    promptTokens: spentPromptTokens,
    completionTokens: spentCompletionTokens,
    lastFailureReason,
  });
}
