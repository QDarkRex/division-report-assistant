import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { getDailyReport } from "../reports/service.ts";
const NOW = () => new Date("2026-08-08T05:00:00.000Z");
import { llmInvocations } from "../db/schema.ts";
import { answerQuery } from "./service.ts";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function intentResponse(intent: unknown, usage = { prompt_tokens: 100, completion_tokens: 30 }) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(intent) } }], usage });
}

test("answerQuery calls the LLM and returns a formatted answer", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return intentResponse({ intent: "missing_reporters" });
  };

  const reply = await answerQuery(db, { baseUrl: "http://litellm.test", fetchImpl }, member.memberId, "siapa yang belum lapor?");
  assert.equal(calls, 1);
  assert.match(reply.text, /lapor/);
});

test("answerQuery records cost telemetry under the query_intent feature", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  const fetchImpl = async () => intentResponse({ intent: "missing_reporters" });
  await answerQuery(db, { baseUrl: "http://litellm.test", fetchImpl }, member.memberId, "siapa yang belum lapor?");

  const rows = await db.select().from(llmInvocations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.feature, "query_intent");
});

test("answerQuery rate-limits a member after 10 queries in an hour, without calling the LLM again", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return intentResponse({ intent: "missing_reporters" });
  };
  const llm = { baseUrl: "http://litellm.test", fetchImpl };
  const now = new Date("2026-08-08T05:00:00.000Z");

  for (let i = 0; i < 10; i++) {
    await answerQuery(db, llm, member.memberId, `pertanyaan ${i}`, now);
  }
  assert.equal(calls, 10);

  const reply = await answerQuery(db, llm, member.memberId, "pertanyaan ke-11", now);
  assert.equal(calls, 10, "the 11th call within the hour must not reach the LLM");
  assert.match(reply.text, /banyak pertanyaan/);
});

test("answerQuery never calls the LLM when the hard budget limit is reached", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  // Push month-to-date spend past the hard limit ($1.56) directly.
  await db.insert(llmInvocations).values({
    feature: "report_extraction",
    model: "deepseek-v4-flash",
    thinkingMode: false,
    promptTokens: 1,
    completionTokens: 1,
    retryCount: 0,
    estimatedCostUsd: "2.00000000",
  });

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return intentResponse({ intent: "missing_reporters" });
  };

  const reply = await answerQuery(db, { baseUrl: "http://litellm.test", fetchImpl }, member.memberId, "siapa yang belum lapor?");
  assert.equal(calls, 0, "hard budget limit must block the LLM call entirely, not just degrade it");
  assert.match(reply.text, /[Kk]uota/);
});

// ---------------------------------------------------------------------
// Confirm-before-mutate (owner decision 2026-09-12). A mutating intent is
// proposed and only runs on an explicit "ya" — so a question misread as a
// check-in (the Gunawan bug) is caught before it changes anything.
// ---------------------------------------------------------------------

test("a mutating intent is proposed, not executed, and asks for confirmation", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Gunawan" });
  await setMembershipStatus(db, member.memberId, "active");

  const fetchImpl = async () => intentResponse({ intent: "overtime_checkin" });
  const reply = await answerQuery(db, { baseUrl: "http://litellm.test", fetchImpl }, member.memberId, "tolong dicek apakah Gunawan ikut lembur hari ini");

  assert.match(reply.text, /Konfirmasi/);
  // Nothing was written — the whole point.
  assert.equal(await getDailyReport(db, member.memberId, "2026-08-08", "overtime"), null);
});

test("replying ya runs the parked mutation, without another LLM call", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  let calls = 0;
  const fetchImpl = async () => { calls++; return intentResponse({ intent: "overtime_checkin" }); };
  const llm = { baseUrl: "http://litellm.test", fetchImpl };

  await answerQuery(db, llm, member.memberId, "mohon dicatat saya lembur dari sore", NOW());
  assert.equal(calls, 1, "the sentence is not a plain lembur phrasing, so the LLM proposed it");
  const confirm = await answerQuery(db, llm, member.memberId, "ya", NOW());
  assert.equal(calls, 1, "confirming spends no further LLM call");
  assert.match(confirm.text, /lembur/i);
  assert.ok(await getDailyReport(db, member.memberId, "2026-08-08", "overtime"), "now it exists");
});

test("replying batal drops the parked mutation", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  const llm = { baseUrl: "http://litellm.test", fetchImpl: async () => intentResponse({ intent: "overtime_checkin" }) };

  await answerQuery(db, llm, member.memberId, "absen lembur", NOW());
  const cancel = await answerQuery(db, llm, member.memberId, "batal", NOW());
  assert.match(cancel.text, /dibatalkan/);
  assert.equal(await getDailyReport(db, member.memberId, "2026-08-08", "overtime"), null);
});

test("ya with nothing pending does nothing and says so", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  const reply = await answerQuery(db, { baseUrl: "http://litellm.test", fetchImpl: async () => { throw new Error("LLM must not be called"); } }, member.memberId, "ya", NOW());
  assert.match(reply.text, /Tidak ada yang perlu dikonfirmasi/);
});

test("a read-only query still runs immediately, no confirmation", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const reply = await answerQuery(db, { baseUrl: "http://litellm.test", fetchImpl: async () => intentResponse({ intent: "missing_reporters" }) }, member.memberId, "siapa belum lapor?");
  assert.doesNotMatch(reply.text, /Konfirmasi/);
});
