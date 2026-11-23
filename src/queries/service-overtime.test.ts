import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { getDailyReport } from "../reports/service.ts";
import { answerQuery } from "./service.ts";

// Overtime intent decided by code (2026-10-09), and the day a confirmed
// check-in lands on. See overtime-intent.ts and shared/time.ts.

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function intentResponse(intent: unknown) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(intent) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
}

async function setup(llmIntent?: unknown) {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Haryono" });
  await setMembershipStatus(db, member.memberId, "active");
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (llmIntent === undefined) throw new Error("LLM must not be called");
    return intentResponse(llmIntent);
  }) as typeof fetch;
  return { db, member, llm: { baseUrl: "http://litellm.test", fetchImpl }, calls: () => calls };
}

const THU_1827 = new Date("2026-10-08T11:27:00.000Z"); // Thursday 18:27 WIB

test("a bare 'lembur' is a check-in decided by code: confirmation asked, no LLM call", async () => {
  const s = await setup();
  const reply = await answerQuery(s.db, s.llm, s.member.memberId, "lembur", THU_1827);
  assert.equal(s.calls(), 0);
  assert.equal(reply.intentSource, "pre_classifier");
  assert.match(reply.text, /Konfirmasi[\s\S]*Absen lembur/);
  assert.equal(await getDailyReport(s.db, s.member.memberId, "2026-10-08", "overtime"), null, "nothing written before the ya");

  const done = await answerQuery(s.db, s.llm, s.member.memberId, "ya", THU_1827);
  assert.equal(done.intentSource, "confirmation");
  assert.match(done.text, /tercatat/);
  assert.equal(s.calls(), 0);
  assert.ok(await getDailyReport(s.db, s.member.memberId, "2026-10-08", "overtime"));
});

test("the time in the message is carried into the confirmed check-in", async () => {
  const s = await setup();
  const reply = await answerQuery(s.db, s.llm, s.member.memberId, "mulai lembur jam 17.00", THU_1827);
  assert.match(reply.text, /Absen lembur jam 17\.00\?/, "no doubled 'jam'");
  await answerQuery(s.db, s.llm, s.member.memberId, "ya", THU_1827);
  assert.equal((await getDailyReport(s.db, s.member.memberId, "2026-10-08", "overtime"))?.overtimeStartText, "jam 17.00");
});

test("a question about overtime lists directly, no confirmation, no LLM call", async () => {
  const s = await setup();
  const reply = await answerQuery(s.db, s.llm, s.member.memberId, "siapa aja yg lembur hari ini?", THU_1827);
  assert.equal(s.calls(), 0);
  assert.equal(reply.intentSource, "pre_classifier");
  assert.match(reply.text, /Belum ada yang lembur/);
  assert.doesNotMatch(reply.text, /Konfirmasi/);
});

test("the pre-classifier is not subject to the per-member LLM rate limit", async () => {
  const s = await setup();
  for (let i = 0; i < 12; i++) {
    const reply = await answerQuery(s.db, s.llm, s.member.memberId, "lembur?", THU_1827);
    assert.doesNotMatch(reply.text, /banyak pertanyaan/);
  }
});

test("a phrasing the classifier does not understand still goes to the LLM, and its mutation is confirmed too", async () => {
  const s = await setup({ intent: "overtime_checkin" });
  const reply = await answerQuery(s.db, s.llm, s.member.memberId, "Nisa lembur", THU_1827);
  assert.equal(s.calls(), 1);
  assert.equal(reply.intentSource, "llm");
  assert.match(reply.text, /Konfirmasi/);
});

test("a check-in proposed at 04:59 and confirmed at 05:01 keeps the day of the original message", async () => {
  const s = await setup();
  const proposed = new Date("2026-10-02T21:59:00.000Z"); // Saturday 04:59 WIB: Friday's evening
  const confirmed = new Date("2026-10-02T22:01:00.000Z"); // Saturday 05:01 WIB: would be the calendar day if "now" were used
  await answerQuery(s.db, s.llm, s.member.memberId, "lembur", proposed);
  await answerQuery(s.db, s.llm, s.member.memberId, "ya", confirmed);
  assert.ok(await getDailyReport(s.db, s.member.memberId, "2026-10-02", "overtime"), "Friday");
  assert.equal(await getDailyReport(s.db, s.member.memberId, "2026-10-03", "overtime"), null);
});

test("a morning check-in proposed at 09:59 and confirmed at 10:01 is Saturday's", async () => {
  const s = await setup();
  await answerQuery(s.db, s.llm, s.member.memberId, "absen lembur", new Date("2026-10-03T02:59:00.000Z"));
  await answerQuery(s.db, s.llm, s.member.memberId, "ya", new Date("2026-10-03T03:01:00.000Z"));
  assert.ok(await getDailyReport(s.db, s.member.memberId, "2026-10-03", "overtime"));
  assert.equal(await getDailyReport(s.db, s.member.memberId, "2026-10-02", "overtime"), null);
});

test("a checkout confirmed later attaches to the open report found at the time of the original message", async () => {
  const s = await setup();
  await answerQuery(s.db, s.llm, s.member.memberId, "lembur", new Date("2026-10-03T02:17:00.000Z")); // Sat 09:17
  await answerQuery(s.db, s.llm, s.member.memberId, "ya", new Date("2026-10-03T02:18:00.000Z"));
  await answerQuery(s.db, s.llm, s.member.memberId, "selesai lembur jam 9", new Date("2026-10-03T02:59:00.000Z")); // 09:59
  await answerQuery(s.db, s.llm, s.member.memberId, "ya", new Date("2026-10-03T03:01:00.000Z")); // 10:01
  assert.equal((await getDailyReport(s.db, s.member.memberId, "2026-10-03", "overtime"))?.overtimeEndText, "jam 9");
});
