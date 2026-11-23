import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember, relinkWhatsappJid, setMembershipStatus } from "../members/service.ts";
import { getDailyReport } from "../reports/service.ts";
import { getPendingConfirmation } from "../queries/confirmation.ts";
import type { IncomingMessage } from "../whatsapp/connector.ts";
import { processIncomingMessage } from "./pipeline.ts";

// Bare "ya"/"batal" without the @mention, 2026-10-09. Production 2026-10-08
// 20:47: Arief answered the confirmation with "Ya" (no tag) and it was ignored.
// Rule: a whole-message confirm/cancel word counts without the mention only
// when the sender has a pending confirmation asked at most 5 minutes ago.
// (The report_match variant is in plan/report-match-items.test.ts.)

const JID = "628111@s.whatsapp.net";
const T0 = new Date("2026-10-08T13:47:00.000Z"); // Thursday 20:47 WIB
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let counter = 0;
async function world() {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Arief" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, JID);
  return { db, member };
}
type World = Awaited<ReturnType<typeof world>>;

/** An LLM that must never be called: every phrasing used here is decided by the pre-classifier or the confirmation words. */
const noLlm = { baseUrl: "http://litellm.test", fetchImpl: (async () => { throw new Error("no LLM call expected"); }) as typeof fetch };

function say(w: World, text: string, now: Date, extra: Partial<IncomingMessage> = {}) {
  counter++;
  return processIncomingMessage(
    { db: w.db, llm: noLlm, now },
    { messageId: `bare-${counter}`, chatJid: "group-1@g.us", isGroup: true, senderJid: JID, text, messageTimestamp: now, receivedAt: now, ...extra },
  );
}

async function proposeCheckin(w: World) {
  const out = await say(w, "@helper mengajukan lembur", T0, { botMentioned: true });
  assert.equal(out.status, "query_answered");
  if (out.status === "query_answered") {
    assert.match(out.replyText, /Konfirmasi/);
    assert.equal(out.intentSource, "pre_classifier");
  }
  assert.ok(await getPendingConfirmation(w.db, w.member.memberId, T0));
}

test("a bare 'Ya' within 5 minutes confirms the parked check-in", async () => {
  const w = await world();
  await proposeCheckin(w);
  const out = await say(w, "Ya", at(2));
  assert.equal(out.status, "query_answered");
  if (out.status === "query_answered") {
    assert.match(out.replyText, /Lembur .* tercatat/);
    assert.equal(out.intentSource, "confirmation");
  }
  assert.ok(await getDailyReport(w.db, w.member.memberId, "2026-10-08", "overtime"));
  assert.equal(await getPendingConfirmation(w.db, w.member.memberId, at(2)), null);
});

test("a bare 'batal' within 5 minutes cancels it", async () => {
  const w = await world();
  await proposeCheckin(w);
  const out = await say(w, "batal", at(1));
  assert.equal(out.status, "query_answered");
  if (out.status === "query_answered") assert.match(out.replyText, /dibatalkan/);
  assert.equal(await getDailyReport(w.db, w.member.memberId, "2026-10-08", "overtime"), null);
});

test("a bare 'ya' after 5 minutes is ignored (and the parked check-in does not run)", async () => {
  const w = await world();
  await proposeCheckin(w);
  const out = await say(w, "ya", at(5.5));
  assert.equal(out.status, "stored_as_context");
  assert.equal(await getDailyReport(w.db, w.member.memberId, "2026-10-08", "overtime"), null);
  // Inside the 30-minute window the tagged form still works.
  const tagged = await say(w, "@helper ya", at(6), { botMentioned: true });
  assert.equal(tagged.status, "query_answered");
  assert.ok(await getDailyReport(w.db, w.member.memberId, "2026-10-08", "overtime"));
});

test("a bare 'ya' with no pending confirmation is ignored", async () => {
  const w = await world();
  const out = await say(w, "ya", at(1));
  assert.equal(out.status, "stored_as_context");
});

test("'ya dong bang' is not a whole-message confirmation, even with one pending", async () => {
  const w = await world();
  await proposeCheckin(w);
  const out = await say(w, "ya dong bang", at(1));
  assert.equal(out.status, "stored_as_context");
  assert.equal(await getDailyReport(w.db, w.member.memberId, "2026-10-08", "overtime"), null);
  assert.ok(await getPendingConfirmation(w.db, w.member.memberId, at(1)), "the question is still open");
});

test("someone else's bare 'ya' does not confirm my pending check-in", async () => {
  const w = await world();
  await proposeCheckin(w);
  const other = await createMember(w.db, { preferredName: "Affan" });
  await setMembershipStatus(w.db, other.memberId, "active");
  await relinkWhatsappJid(w.db, other.memberId, "628222@s.whatsapp.net");
  const out = await say(w, "ya", at(1), { senderJid: "628222@s.whatsapp.net" });
  assert.equal(out.status, "stored_as_context");
  assert.equal(await getDailyReport(w.db, w.member.memberId, "2026-10-08", "overtime"), null);
});

test("the same '@bot lembur' always gets the same answer, with no LLM call", async () => {
  const w = await world();
  const first = await say(w, "@helper lembur", T0, { botMentioned: true });
  const second = await say(w, "@helper lembur", at(1), { botMentioned: true });
  for (const out of [first, second]) {
    assert.equal(out.status, "query_answered");
    if (out.status === "query_answered") assert.match(out.replyText, /Konfirmasi[\s\S]*Absen lembur/);
  }
});
