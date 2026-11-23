import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../db/testing.ts";
import { pendingConfirmations, planItems, reportItemFlags, reportItems, taskAssignees, taskContributors, tasks } from "../db/schema.ts";
import { createMember, relinkWhatsappJid, setMembershipStatus } from "../members/service.ts";
import { listUnresolvedCandidates } from "../tasks/candidates.ts";
import { processIncomingMessage, type PipelineDeps } from "../messages/pipeline.ts";
import { formatAcknowledgment } from "../messages/acknowledgment.ts";
import { answerQuery } from "../queries/service.ts";
import { getPendingConfirmation, setPendingConfirmation, type ReportMatchItem } from "../queries/confirmation.ts";
import type { IncomingMessage } from "../whatsapp/connector.ts";
import { taskStatusForPlan } from "./mapping.ts";
import { REPORT_MATCH_HELP } from "./report-match.ts";
import { FLAG_DONE_VS_PLAN, FLAG_LOW_CONFIDENCE } from "./flags.ts";

const NOW = new Date("2026-08-07T03:05:00.000Z"); // Friday 10:05 WIB
// 09:30 WIB belongs to the PREVIOUS reporting day (a day runs 10:00 -> 10:00), 35 minutes before NOW.
const EARLY = new Date("2026-08-07T02:30:00.000Z");
const LATER = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const SENDER_JID = "628111@s.whatsapp.net";

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

async function world() {
  const db = await createTestDb();
  const sender = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, sender.memberId, "active");
  await relinkWhatsappJid(db, sender.memberId, SENDER_JID);
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  return { db, sender, admin };
}
type World = Awaited<ReturnType<typeof world>>;

async function seedPlanTask(w: World, id: string, step: string, status = "Berjalan") {
  const title = `BMS Drone: ${step}`;
  const [task] = await w.db
    .insert(tasks)
    .values({
      title,
      normalizedTitle: title.toLowerCase(),
      createdByMemberId: w.admin.memberId,
      sourceReference: `master-plan-aerolift:${id}`,
      status: taskStatusForPlan(status) ?? "active",
    })
    .returning();
  await w.db.insert(taskAssignees).values({ taskId: task!.taskId, memberId: w.sender.memberId });
  await w.db.insert(planItems).values({
    planRef: `aerolift:${id}`,
    taskId: task!.taskId,
    area: "BMS Drone",
    step,
    picRaw: "Agas",
    startDate: "2026-08-01",
    deadlineDate: "2026-08-30",
    statusText: status,
    lastSeenAt: NOW,
  });
  return task!;
}

let counter = 0;
interface Reported {
  activity: string;
  status?: string;
  matchedTaskId?: string;
  matchConfidence?: string;
}
async function report(w: World, items: Reported[], opts: { now?: Date; text?: string } = {}) {
  counter++;
  const fetchImpl = (async () =>
    jsonResponse({
      choices: [{ message: { content: JSON.stringify({ noActivity: false, items: items.map((i) => ({ status: "in_progress", ...i })) }) } }],
      usage: { prompt_tokens: 500, completion_tokens: 150 },
    })) as typeof fetch;
  const now = opts.now ?? NOW;
  const deps: PipelineDeps = { db: w.db, llm: { baseUrl: "http://litellm.test", fetchImpl }, now };
  const message: IncomingMessage = {
    messageId: `wa-items-${counter}`,
    chatJid: "group-1@g.us",
    isGroup: true,
    senderJid: SENDER_JID,
    text: opts.text ?? `report\n- pekerjaan ${counter}`,
    messageTimestamp: now,
    receivedAt: now,
  };
  return processIncomingMessage(deps, message);
}

const noLlm = { baseUrl: "http://litellm.test", fetchImpl: (async () => { throw new Error("no LLM call expected"); }) as typeof fetch };
const say = (w: World, text: string, now = LATER(1)) => answerQuery(w.db, noLlm, w.sender.memberId, text, now);
const pendingItems = async (w: World, now = NOW): Promise<ReportMatchItem[] | null> => {
  const pending = await getPendingConfirmation(w.db, w.sender.memberId, now);
  return pending?.kind === "report_match" ? pending.match.items : null;
};
const itemTask = async (db: TestDb, activity: string) => (await db.select().from(reportItems).where(eq(reportItems.activity, activity)))[0]?.taskId ?? null;
const flagsOfKind = async (db: TestDb, kind: string) => (await db.select().from(reportItemFlags)).filter((f) => f.kind === kind);

/** 1 = sure link to 1.03; 2 and 3 = unsure (1.02, 1.01). */
async function mixedReport(w: World) {
  const a = await seedPlanTask(w, "1.03", "Soldering PCB indikator LED");
  const b = await seedPlanTask(w, "1.02", "Soldering PCB BMS 4S");
  const c = await seedPlanTask(w, "1.01", "Testing fungsional");
  const outcome = await report(w, [
    { activity: "solder indikator LED", matchedTaskId: a.taskId, matchConfidence: "high" },
    { activity: "solder board baterai", matchedTaskId: b.taskId, matchConfidence: "low" },
    { activity: "testing ethernet set 1", matchedTaskId: c.taskId, matchConfidence: "low" },
  ]);
  return { a, b, c, outcome };
}

test("every plan-related item is numbered once across links and questions, and all are parked", async () => {
  const w = await world();
  const { a, b, c, outcome } = await mixedReport(w);

  assert.equal(
    formatAcknowledgment(outcome),
    [
      "✅ *Laporan Agas tercatat*",
      "3 aktivitas · 1 update task",
      "",
      "🔗 *Terkait task urgent*",
      '1. "solder indikator LED" → [1.03] Soldering PCB indikator LED',
      "",
      "❓ *Cek dulu ya*",
      '2. "solder board baterai" → [1.02] Soldering PCB BMS 4S',
      '3. "testing ethernet set 1" → [1.01] Testing fungsional',
      "Balas *@helper ya* kalau semua benar, atau per nomor: *@helper 2 ya 3 bukan* · *@helper 3 = 2.08*",
    ].join("\n"),
  );

  const items = (await pendingItems(w))!;
  assert.deepEqual(
    items.map((i) => [i.n, i.state, i.taskId, i.flagId === null]),
    [
      [1, "linked", a.taskId, true],
      [2, "question", b.taskId, false],
      [3, "question", c.taskId, false],
    ],
  );
});

test("'2 ya 3 bukan' links 2, rejects 3 (flag rejected, candidate task), keeps 1, and clears the row", async () => {
  const w = await world();
  const { a, b } = await mixedReport(w);

  const reply = await say(w, "2 ya 3 bukan");

  assert.equal(reply.text, "✅ 2 → [1.02] · ❌ 3 tidak terkait");
  assert.equal(await itemTask(w.db, "solder indikator LED"), a.taskId);
  assert.equal(await itemTask(w.db, "solder board baterai"), b.taskId);
  assert.equal(await itemTask(w.db, "testing ethernet set 1"), null);
  const states = (await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE)).map((f) => f.state).sort();
  assert.deepEqual(states, ["confirmed", "rejected"]);
  assert.equal((await listUnresolvedCandidates(w.db)).length, 0);
  assert.equal(await pendingItems(w), null, "no question left: the row is gone");
});

test("answering only some numbers keeps the rest pending and does not restart the clock", async () => {
  const w = await world();
  await mixedReport(w);
  const [before] = await w.db.select().from(pendingConfirmations);

  const reply = await say(w, "ya 2");

  assert.equal(reply.text, "✅ 2 → [1.02] · ⏳ masih menunggu: 3");
  const items = (await pendingItems(w))!;
  assert.deepEqual(items.map((i) => [i.n, i.state]), [[1, "linked"], [2, "linked"], [3, "question"]]);
  const [after] = await w.db.select().from(pendingConfirmations);
  assert.equal(after?.createdAt.getTime(), before?.createdAt.getTime());
});

test("a bare 'ya' confirms only the questions and leaves links alone; a bare 'bukan' rejects only the questions", async () => {
  const w = await world();
  const { a } = await mixedReport(w);
  assert.equal((await say(w, "ya")).text, "✅ 2 → [1.02] · ✅ 3 → [1.01]");
  assert.equal(await itemTask(w.db, "solder indikator LED"), a.taskId);
  assert.equal(await pendingItems(w), null);

  const w2 = await world();
  const second = await mixedReport(w2);
  assert.equal((await say(w2, "bukan")).text, "❌ 2 tidak terkait · ❌ 3 tidak terkait");
  assert.equal(await itemTask(w2.db, "solder indikator LED"), second.a.taskId, "the sure link survives a bare 'bukan'");
});

test("'3 = 1.03' points an item at another OPEN plan task and runs the comparison flags for it", async () => {
  const w = await world();
  const { a } = await mixedReport(w);
  const target = await seedPlanTask(w, "2.08", "Pasang konektor", "Berjalan");

  const reply = await say(w, "3 = 2.08");

  assert.match(reply.text, /^✅ 3 → \[2\.08\] · ⏳ masih menunggu: 2$/);
  assert.equal(await itemTask(w.db, "testing ethernet set 1"), target.taskId);
  const contributors = await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, target.taskId));
  assert.equal(contributors.length, 1);
  const lowConf = await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE);
  assert.deepEqual(lowConf.map((f) => f.state).sort(), ["confirmed", "open", "rejected"], "old guess rejected, new link confirmed, item 2 still open");
  const items = (await pendingItems(w))!;
  assert.equal(items.find((i) => i.n === 3)?.state, "linked");
  assert.equal(items.find((i) => i.n === 3)?.taskId, target.taskId);
  assert.equal(items.find((i) => i.n === 1)?.taskId, a.taskId);
});

test("a correction to a 'done' status item raises done_vs_plan against the NEW step", async () => {
  const w = await world();
  const b = await seedPlanTask(w, "1.02", "Soldering PCB BMS 4S");
  await seedPlanTask(w, "2.08", "Pasang konektor", "Berjalan");
  await report(w, [{ activity: "pasang konektor", status: "done", matchedTaskId: b.taskId, matchConfidence: "low" }]);

  await say(w, "1 = 2.08");

  const flags = await flagsOfKind(w.db, FLAG_DONE_VS_PLAN);
  assert.equal(flags.length, 1);
  assert.equal((flags[0]?.detail as { planRef: string }).planRef, "aerolift:2.08");
});

test("a correction to an unknown or closed step id leaves the item untouched", async () => {
  const w = await world();
  await mixedReport(w);
  await seedPlanTask(w, "9.01", "Sudah selesai", "Selesai");
  const before = JSON.stringify(await pendingItems(w));

  for (const [text, id] of [["3 = 9.99", "9.99"], ["3 = 9.01", "9.01"]] as const) {
    const reply = await say(w, text);
    assert.equal(reply.text, `⚠️ 3: ID ${id} tidak dikenal atau sudah tidak aktif · ⏳ masih menunggu: 2, 3`);
  }
  assert.equal(await itemTask(w.db, "testing ethernet set 1"), null);
  assert.equal(JSON.stringify(await pendingItems(w)), before);
});

test("rejecting a LINKED item unlinks it, drops the contributor, records a rejected flag and closes the comparison flags", async () => {
  const w = await world();
  const a = await seedPlanTask(w, "1.03", "Soldering PCB indikator LED");
  await report(w, [{ activity: "solder indikator LED", status: "done", matchedTaskId: a.taskId, matchConfidence: "high" }]);
  assert.equal((await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, a.taskId))).length, 1);
  assert.equal((await flagsOfKind(w.db, FLAG_DONE_VS_PLAN))[0]?.state, "open");

  const reply = await say(w, "1 bukan");

  assert.equal(reply.text, "❌ 1 tidak terkait");
  assert.equal(await itemTask(w.db, "solder indikator LED"), null);
  assert.equal((await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, a.taskId))).length, 0);
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE))[0]?.state, "rejected");
  assert.equal((await flagsOfKind(w.db, FLAG_DONE_VS_PLAN))[0]?.state, "rejected");
  assert.equal((await listUnresolvedCandidates(w.db)).length, 0);
  assert.equal(await pendingItems(w), null);
});

test("rejecting a linked item keeps the contributor when another item of the member still links the same task", async () => {
  const w = await world();
  const a = await seedPlanTask(w, "1.03", "Soldering PCB indikator LED");
  await report(w, [
    { activity: "solder indikator LED", matchedTaskId: a.taskId, matchConfidence: "high" },
    { activity: "solder indikator LED bagian dua", matchedTaskId: a.taskId, matchConfidence: "high" },
  ]);

  await say(w, "1 bukan");

  assert.equal((await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, a.taskId))).length, 1);
  assert.equal(await itemTask(w.db, "solder indikator LED bagian dua"), a.taskId);
});

test("a link-only report keeps its row for corrections; '1 = 1.04' re-links, a plain 'ya' changes nothing", async () => {
  const w = await world();
  const a = await seedPlanTask(w, "1.03", "Soldering PCB indikator LED");
  const other = await seedPlanTask(w, "1.04", "Tes fungsi");
  const outcome = await report(w, [{ activity: "solder indikator LED", matchedTaskId: a.taskId, matchConfidence: "high" }]);
  assert.match(formatAcknowledgment(outcome) ?? "", /Salah cocok\? Balas \*@helper 1 bukan\* atau \*@helper 1 = 1\.04\*$/);

  assert.equal((await say(w, "ya")).text, "Semua sudah terkait, tidak ada yang perlu dikonfirmasi.");
  assert.ok(await pendingItems(w));

  assert.equal((await say(w, "1 = 1.04")).text, "✅ 1 → [1.04]");
  assert.equal(await itemTask(w.db, "solder indikator LED"), other.taskId);
  assert.equal((await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, a.taskId))).length, 0);
  assert.equal((await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, other.taskId))).length, 1);
});

test("a number that is not in the list is reported, ambiguous input gets the help text, ordinary questions still reach the query path", async () => {
  const w = await world();
  await mixedReport(w);

  assert.equal((await say(w, "9 ya")).text, "⚠️ nomor 9 tidak ada · ⏳ masih menunggu: 2, 3");
  assert.equal((await say(w, "2 ya bukan 3")).text, REPORT_MATCH_HELP);
  assert.match((await say(w, "tugas Nisa besok apa")).text, /gangguan teknis/, "handed to the intent parser (which the test blocks)");
  assert.equal((await pendingItems(w))?.length, 3, "nothing above changed the row");
});

test("report questions live 12 hours; a reply after that finds nothing", async () => {
  const w = await world();
  await mixedReport(w);

  assert.ok(await pendingItems(w, LATER(11 * 60)));
  assert.equal((await say(w, "ya", LATER(13 * 60))).text, "Tidak ada yang perlu dikonfirmasi.");
  assert.equal((await say(w, "ya", LATER(11 * 60))).text, "✅ 2 → [1.02] · ✅ 3 → [1.01]");
});

test("a row written in the old shape (no n/state) is read as open questions", async () => {
  const w = await world();
  const b = await seedPlanTask(w, "1.02", "Soldering PCB BMS 4S");
  await report(w, [{ activity: "solder board baterai", matchedTaskId: b.taskId, matchConfidence: "low" }]);
  const items = (await pendingItems(w))!;
  await w.db
    .update(pendingConfirmations)
    .set({ intent: { reportId: "r", items: items.map((i) => ({ itemId: i.itemId, taskId: i.taskId, planRef: i.planRef, flagId: i.flagId })) } });

  assert.equal((await say(w, "ya")).text, "✅ 1 → [1.02]");
});

test("a second report MERGES into the open questions: numbers continue, nothing is overwritten", async () => {
  const w = await world();
  const b = await seedPlanTask(w, "1.02", "Soldering PCB BMS 4S");
  const c = await seedPlanTask(w, "1.01", "Testing fungsional");
  await report(w, [{ activity: "solder board baterai", matchedTaskId: b.taskId, matchConfidence: "low" }], { now: EARLY });

  const nextDay = NOW; // the next reporting day: a different report
  const outcome = await report(w, [{ activity: "testing ethernet", matchedTaskId: c.taskId, matchConfidence: "low" }], { now: nextDay });

  const items = (await pendingItems(w, nextDay))!;
  assert.deepEqual(items.map((i) => [i.n, i.taskId]), [[1, b.taskId], [2, c.taskId]]);
  if (outcome.status === "report_processed") assert.equal(outcome.plan?.questions[0]?.n, 2);

  assert.equal((await say(w, "ya 1", new Date(nextDay.getTime() + 60_000))).text, "✅ 1 → [1.02] · ⏳ masih menunggu: 2");
  assert.equal(await itemTask(w.db, "solder board baterai"), b.taskId);
});

test("a revision supersedes its own earlier items in the pending row, while another day's stay", async () => {
  const w = await world();
  const b = await seedPlanTask(w, "1.02", "Soldering PCB BMS 4S");
  const c = await seedPlanTask(w, "1.01", "Testing fungsional");
  await report(w, [{ activity: "solder board baterai", matchedTaskId: b.taskId, matchConfidence: "low" }], { now: EARLY });
  await report(w, [{ activity: "testing ethernet", matchedTaskId: c.taskId, matchConfidence: "low" }], { now: NOW });

  // Day 2 revised: the old item 2 is replaced by a new one, numbered after the highest KEPT number (the revised report's own ack shows these numbers).
  const nextDay = LATER(5);
  await report(w, [{ activity: "testing ethernet set 1", matchedTaskId: c.taskId, matchConfidence: "low" }], { now: nextDay });

  const items = (await pendingItems(w, nextDay))!;
  assert.deepEqual(items.map((i) => [i.n, i.taskId]), [[1, b.taskId], [2, c.taskId]]);
  assert.equal((await say(w, "3 ya", new Date(nextDay.getTime() + 60_000))).text, "⚠️ nomor 3 tidak ada · ⏳ masih menunggu: 1, 2");
});

test("a pending QUERY confirmation is replaced by a report's questions", async () => {
  const w = await world();
  await setPendingConfirmation(w.db, w.sender.memberId, { intent: "overtime_checkin" }, NOW);
  const b = await seedPlanTask(w, "1.02", "Soldering PCB BMS 4S");

  await report(w, [{ activity: "solder", matchedTaskId: b.taskId, matchConfidence: "low" }]);

  assert.equal((await getPendingConfirmation(w.db, w.sender.memberId, NOW))?.kind, "report_match");
  assert.equal((await w.db.select().from(pendingConfirmations)).length, 1);
});

// ---------------------------------------------------------------------
// Bare "ya"/"bukan" WITHOUT the @mention, 2026-10-09. Production 2026-10-08:
// a member answered "Ya" to the bot's confirmation and was ignored because he
// did not tag it. A whole-message confirm/cancel word is accepted without the
// mention only while the sender's question is at most 5 minutes old.
// ---------------------------------------------------------------------

const sayInGroup = (w: World, text: string, now: Date, id: string) =>
  processIncomingMessage(
    { db: w.db, llm: noLlm, now },
    { messageId: id, chatJid: "group-1@g.us", isGroup: true, senderJid: SENDER_JID, text, messageTimestamp: now, receivedAt: now },
  );

test("a bare 'ya' without the mention answers the report questions within 5 minutes", async () => {
  const w = await world();
  await mixedReport(w);
  const out = await sayInGroup(w, "Ya", LATER(4), "bare-1");
  assert.equal(out.status, "query_answered");
  if (out.status === "query_answered") assert.equal(out.replyText, "✅ 2 → [1.02] · ✅ 3 → [1.01]");
  assert.equal(await pendingItems(w), null);
});

test("a bare 'ya' after 5 minutes is ordinary chat, and the question stays open", async () => {
  const w = await world();
  await mixedReport(w);
  const out = await sayInGroup(w, "ya", LATER(6), "bare-2");
  assert.equal(out.status, "stored_as_context");
  assert.ok(await pendingItems(w, LATER(6)), "still pending");
});

test("per-number answers stay mention-only, even within 5 minutes", async () => {
  const w = await world();
  await mixedReport(w);
  const out = await sayInGroup(w, "2 ya 3 bukan", LATER(1), "bare-3");
  assert.equal(out.status, "stored_as_context");
  assert.equal((await pendingItems(w, LATER(1)))?.length, 3, "nothing was applied");
});

test("a bare 'ya' with nothing pending is ordinary chat", async () => {
  const w = await world();
  const out = await sayInGroup(w, "ya", LATER(1), "bare-4");
  assert.equal(out.status, "stored_as_context");
});
