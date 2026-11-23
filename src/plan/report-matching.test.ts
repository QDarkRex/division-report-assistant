import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../db/testing.ts";
import { pendingConfirmations, planItems, reportItemFlags, reportItems, taskAssignees, taskContributors, taskEvents, tasks } from "../db/schema.ts";
import { createMember, relinkWhatsappJid, setMembershipStatus } from "../members/service.ts";
import { createTask, getTask, listTasksByStatus } from "../tasks/service.ts";
import { listUnresolvedCandidates } from "../tasks/candidates.ts";
import { getDailyReport, getLatestRevision, listItemsForRevision } from "../reports/service.ts";
import { processIncomingMessage, type PipelineDeps, type PlanAckData } from "../messages/pipeline.ts";
import { formatAcknowledgment } from "../messages/acknowledgment.ts";
import { answerQuery } from "../queries/service.ts";
import { getPendingConfirmation, setPendingConfirmation } from "../queries/confirmation.ts";
import type { IncomingMessage } from "../whatsapp/connector.ts";
import { taskStatusForPlan } from "./mapping.ts";
import {
  FLAG_BLOCKED_VS_PLAN,
  FLAG_DEPENDENCY_OPEN,
  FLAG_DONE_VS_PLAN,
  FLAG_EARLY_START,
  FLAG_KINDS,
  FLAG_LOW_CONFIDENCE,
  FLAG_NO_URGENT_WORK,
  FLAG_OTHER_PIC,
} from "./flags.ts";
import { buildExtractionCandidates, formatCandidateLine, parseDependencyIds } from "./matching.ts";

const NOW = new Date("2026-08-07T03:05:00.000Z"); // 10:05 WIB -> reporting day 2026-08-07
const DAY = "2026-08-07";
const SENDER_JID = "628111@s.whatsapp.net";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function extractionResponse(data: unknown) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 500, completion_tokens: 150 } });
}

interface World {
  db: TestDb;
  sender: { memberId: string };
  other: { memberId: string };
  admin: { memberId: string };
}

async function world(): Promise<World> {
  const db = await createTestDb();
  const sender = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, sender.memberId, "active");
  await relinkWhatsappJid(db, sender.memberId, SENDER_JID);
  const other = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, other.memberId, "active");
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  return { db, sender, other, admin };
}

interface PlanSeed {
  id: string;
  step?: string;
  assignees?: string[];
  start?: string | null;
  deadline?: string | null;
  status?: string;
  dependsOn?: string | null;
  picRaw?: string | null;
}

/** A plan task exactly as the sync leaves it: task + assignees + plan_items row. */
async function seedPlanTask(w: World, seed: PlanSeed) {
  const statusText = seed.status ?? "Berjalan";
  const title = `BMS Drone: ${seed.step ?? `Langkah ${seed.id}`}`;
  const [task] = await w.db
    .insert(tasks)
    .values({
      title,
      normalizedTitle: title.toLowerCase(),
      createdByMemberId: w.admin.memberId,
      sourceReference: `master-plan-aerolift:${seed.id}`,
      status: taskStatusForPlan(statusText) ?? "active",
    })
    .returning();
  for (const memberId of seed.assignees ?? [w.sender.memberId]) {
    await w.db.insert(taskAssignees).values({ taskId: task!.taskId, memberId });
  }
  await w.db.insert(planItems).values({
    planRef: `aerolift:${seed.id}`,
    taskId: task!.taskId,
    area: "BMS Drone",
    step: seed.step ?? `Langkah ${seed.id}`,
    picRaw: seed.picRaw === undefined ? "Agas" : seed.picRaw,
    startDate: seed.start === undefined ? "2026-08-05" : seed.start,
    deadlineDate: seed.deadline === undefined ? "2026-08-09" : seed.deadline,
    statusText,
    dependsOn: seed.dependsOn ?? null,
    lastSeenAt: NOW,
  });
  return task!;
}

let messageCounter = 0;
function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  messageCounter++;
  return {
    messageId: `wa-plan-${messageCounter}`,
    chatJid: "group-1@g.us",
    isGroup: true,
    senderJid: SENDER_JID,
    text: `report\n- pekerjaan: dummy ${messageCounter}`,
    messageTimestamp: NOW,
    receivedAt: NOW,
    ...overrides,
  };
}

interface Reported {
  activity?: string;
  status?: string;
  obstacle?: string;
  matchedTaskId?: string;
  matchConfidence?: string;
  matchReason?: string;
}

/** Runs one report through the real pipeline with the model replaced by `items`; returns the outcome and every request body sent. */
async function report(w: World, items: Reported[], message: Partial<IncomingMessage> = {}) {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return extractionResponse({ noActivity: false, items: items.map((i) => ({ activity: "kerja", status: "in_progress", ...i })) });
  }) as typeof fetch;
  const deps: PipelineDeps = { db: w.db, llm: { baseUrl: "http://litellm.test", fetchImpl }, now: NOW };
  const outcome = await processIncomingMessage(deps, makeMessage(message));
  return { outcome, requests };
}

const allFlags = (db: TestDb) => db.select().from(reportItemFlags);
const flagsOfKind = async (db: TestDb, kind: string) => (await allFlags(db)).filter((f) => f.kind === kind);
const queryLlm = { baseUrl: "http://litellm.test", fetchImpl: (async () => { throw new Error("no LLM call expected"); }) as typeof fetch };

// --- constants ----------------------------------------------------------------

test("the flag kind strings are exactly the ones the morning summary reads", () => {
  assert.deepEqual([...FLAG_KINDS], ["low_confidence", "other_pic", "done_vs_plan", "blocked_vs_plan", "early_start", "dependency_open", "no_urgent_work"]);
});

test("dependency ids are read from a Dependensi cell and free text is ignored", () => {
  assert.deepEqual(parseDependencyIds("3.05, 3.06"), ["3.05", "3.06"]);
  assert.deepEqual(parseDependencyIds("Tahap 1–3"), []);
  assert.deepEqual(parseDependencyIds("setelah 2.01 selesai; lihat Tahap 1–3 dan 2.01"), ["2.01"]);
  assert.deepEqual(parseDependencyIds(null), []);
});

// --- candidates -----------------------------------------------------------------

test("candidates: own plan tasks (today's window first), own other tasks, then others' plan tasks due today, then general; closed and out-of-window ones left out", async () => {
  const w = await world();
  const own = await createTask(w.db, { title: "Tugas pribadi", createdByMemberId: w.admin.memberId });
  await w.db.insert(taskAssignees).values({ taskId: own.taskId, memberId: w.sender.memberId });
  const ownOutOfWindow = await seedPlanTask(w, { id: "1.02", start: "2026-09-01", deadline: "2026-09-05" });
  const ownInWindow = await seedPlanTask(w, { id: "1.01" });
  const othersInWindow = await seedPlanTask(w, { id: "2.01", assignees: [w.other.memberId] });
  await seedPlanTask(w, { id: "2.02", assignees: [w.other.memberId], start: "2026-09-01", deadline: "2026-09-05" }); // not due today
  const ownDone = await seedPlanTask(w, { id: "1.03", status: "Selesai" });
  const general = await createTask(w.db, { title: "Tugas umum", createdByMemberId: w.admin.memberId });
  const generalTasks = await listTasksByStatus(w.db, "active");

  const candidates = await buildExtractionCandidates(w.db, { senderId: w.sender.memberId, reportingDay: DAY, budgetStatus: "normal", generalLimit: 5, generalTasks });

  assert.deepEqual(
    candidates.map((c) => c.taskId),
    [ownInWindow.taskId, ownOutOfWindow.taskId, own.taskId, othersInWindow.taskId, general.taskId],
  );
  assert.ok(!candidates.some((c) => c.taskId === ownDone.taskId), "a finished task is not a candidate");

  const soft = await buildExtractionCandidates(w.db, { senderId: w.sender.memberId, reportingDay: DAY, budgetStatus: "soft_limit", generalLimit: 3, generalTasks });
  assert.deepEqual(
    soft.map((c) => c.taskId),
    [ownInWindow.taskId, ownOutOfWindow.taskId, own.taskId],
    "under a budget limit only the sender's own tasks are sent",
  );
});

test("candidates: own tasks are capped at 25, others' plan tasks due today at 15, and nothing appears twice", async () => {
  const w = await world();
  for (let i = 1; i <= 30; i++) await seedPlanTask(w, { id: `1.${String(i).padStart(2, "0")}` });
  for (let i = 1; i <= 20; i++) await seedPlanTask(w, { id: `2.${String(i).padStart(2, "0")}`, assignees: [w.other.memberId] });

  const candidates = await buildExtractionCandidates(w.db, { senderId: w.sender.memberId, reportingDay: DAY, budgetStatus: "normal", generalLimit: 5, generalTasks: [] });

  assert.equal(candidates.length, 25 + 15);
  assert.equal(new Set(candidates.map((c) => c.taskId)).size, candidates.length);
  assert.ok(candidates.slice(0, 25).every((c) => c.planId?.startsWith("1.")), "the sender's own come first");
  // The 5 own tasks past the cap are still due today, so they may re-enter as "others in the window".
  assert.equal(candidates.slice(25).length, 15);
});

test("the prompt carries id, plan ref, title, PIC, window and plan status — PICs as redaction tokens, never names", async () => {
  const w = await world();
  const mine = await seedPlanTask(w, { id: "1.01", step: "Soldering PCB BMS 4S" });
  const theirs = await seedPlanTask(w, { id: "2.01", assignees: [w.other.memberId] });

  const { requests } = await report(w, [{ activity: "solder pcb" }]);

  const prompt = requests[0]!.messages.find((m) => m.role === "user")!.content;
  assert.match(prompt, new RegExp(`- ${mine.taskId} \\[1\\.01\\] BMS Drone: Soldering PCB BMS 4S \\| PIC: pengirim \\| jadwal: 2026-08-05 s/d 2026-08-09 \\| status plan: Berjalan`));
  assert.match(prompt, new RegExp(`- ${theirs.taskId} \\[2\\.01\\] .* \\| PIC: \\[MEMBER:${w.other.memberId}\\]`));
  assert.ok(!prompt.includes("Budi"), "member names stay out of the prompt");
  assert.ok(prompt.indexOf(mine.taskId) < prompt.indexOf(theirs.taskId), "the sender's own task is listed first");
  const system = requests[0]!.messages.find((m) => m.role === "system")!.content;
  assert.match(system, /MAKNA pekerjaan/);
  assert.match(system, /matchConfidence/);
});

test("an ordinary task keeps the original one-line prompt shape", () => {
  assert.equal(
    formatCandidateLine({ taskId: "t1", title: "Cek panel", planId: null, pics: [], startDate: null, deadlineDate: null, planStatus: null }),
    "- t1: Cek panel",
  );
});

// --- matching a plan task -----------------------------------------------------------

test("high confidence: the item links, the sender becomes a contributor, and the plan task's status and history are untouched", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01", step: "Soldering PCB BMS 4S", status: "Belum Mulai", start: "2026-08-05" });
  const before = await getTask(w.db, task.taskId);

  const { outcome } = await report(w, [{ activity: "solder pcb bms", status: "done", matchedTaskId: task.taskId, matchConfidence: "high" }]);

  assert.equal(outcome.status, "report_processed");
  const after = await getTask(w.db, task.taskId);
  assert.equal(after?.status, before?.status, "a report never changes a plan task's status");
  assert.equal(after?.version, before?.version);
  assert.deepEqual(await w.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.taskId)), []);
  const contributors = await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, task.taskId));
  assert.deepEqual(contributors.map((c) => c.memberId), [w.sender.memberId]);
  const items = await w.db.select().from(reportItems);
  assert.equal(items[0]?.taskId, task.taskId);
  assert.deepEqual(await listUnresolvedCandidates(w.db), []);
  if (outcome.status === "report_processed") {
    assert.equal(outcome.summary.taskDoneCount, 0, "not counted as 'task selesai' — the plan decides that");
    assert.equal(outcome.summary.taskUpdateCount, 1);
    assert.equal(outcome.plan?.linked[0]?.sourceReference, "master-plan-aerolift:1.01");
    assert.deepEqual(outcome.plan?.questions, []);
    assert.match(formatAcknowledgment(outcome) ?? "", /1\. "solder pcb bms" → \[1\.01\] Soldering PCB BMS 4S/);
  }
});

test("a non-plan task still follows the report's status, with or without a confidence", async () => {
  const w = await world();
  const task = await createTask(w.db, { title: "Cek panel B", createdByMemberId: w.admin.memberId });

  const { outcome } = await report(w, [{ activity: "cek panel", status: "in_progress", matchedTaskId: task.taskId, matchConfidence: "low" }]);

  assert.equal((await getTask(w.db, task.taskId))?.status, "in_progress");
  assert.equal(await w.db.select().from(reportItemFlags).then((r) => r.length), 0);
  if (outcome.status === "report_processed") assert.equal(outcome.plan, undefined);
});

test("an exact-title match on a plan task counts as high confidence", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01", step: "Soldering PCB BMS 4S" });

  await report(w, [{ activity: "BMS Drone: Soldering PCB BMS 4S" }]);

  assert.equal((await w.db.select().from(reportItems))[0]?.taskId, task.taskId);
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE)).length, 0);
});

test("low confidence (or none given): not linked, a flag, a pending confirmation, a question in the ack, no 'new task' proposal", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01", step: "Soldering PCB BMS 4S" });

  const { outcome } = await report(w, [{ activity: "solder-solder board baterai", matchedTaskId: task.taskId, matchReason: "sama-sama soldering BMS" }]);

  const [item] = await w.db.select().from(reportItems);
  assert.equal(item?.taskId, null);
  assert.deepEqual(await w.db.select().from(taskContributors), []);
  assert.deepEqual(await listUnresolvedCandidates(w.db), []);

  const [flag] = await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE);
  assert.equal(flag?.state, "open");
  assert.equal(flag?.itemId, item?.itemId);
  assert.equal(flag?.taskId, task.taskId);
  const detail = flag?.detail as Record<string, unknown>;
  assert.equal(detail.planRef, "aerolift:1.01");
  assert.equal(detail.taskId, task.taskId);
  assert.equal(detail.activity, "solder-solder board baterai");
  assert.equal(detail.reason, "sama-sama soldering BMS");

  const pending = await getPendingConfirmation(w.db, w.sender.memberId, NOW);
  assert.equal(pending?.kind, "report_match");
  assert.deepEqual(pending?.kind === "report_match" ? pending.match.items : null, [{ n: 1, itemId: item!.itemId, taskId: task.taskId, planRef: "aerolift:1.01", flagId: flag!.flagId, state: "question" }]);
  const [row] = await w.db.select().from(pendingConfirmations);
  assert.equal(row?.kind, "report_match");

  assert.equal(outcome.status, "report_processed");
  if (outcome.status === "report_processed") {
    assert.equal(
      formatAcknowledgment(outcome),
      [
        "✅ *Laporan Agas tercatat*",
        "1 aktivitas",
        "",
        "❓ *Cek dulu ya*",
        '1. "solder-solder board baterai" → [1.01] Soldering PCB BMS 4S',
        "Balas *@helper ya* kalau benar, atau *@helper 1 bukan* · *@helper 1 = 2.08*",
      ].join("\n"),
    );
  }
});

test("a model value outside the schema reads as low confidence instead of failing the report", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01" });

  const { outcome } = await report(w, [{ matchedTaskId: task.taskId, matchConfidence: "very-sure" }]);

  assert.equal(outcome.status, "report_processed");
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE)).length, 1);
});

test("'@helper ya' links the unsure items, closes their flags as confirmed, and raises the comparison flags", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01", step: "Soldering PCB BMS 4S" });
  await report(w, [{ activity: "solder board baterai", status: "done", matchedTaskId: task.taskId }]);

  const reply = await answerQuery(w.db, queryLlm, w.sender.memberId, "ya", new Date(NOW.getTime() + 60_000));

  assert.equal(reply.text, "✅ 1 → [1.01]");
  const [item] = await w.db.select().from(reportItems);
  assert.equal(item?.taskId, task.taskId);
  const contributors = await w.db.select().from(taskContributors).where(eq(taskContributors.taskId, task.taskId));
  assert.equal(contributors.length, 1);
  const [flag] = await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE);
  assert.equal(flag?.state, "confirmed");
  assert.ok(flag?.resolvedAt);
  assert.equal((await flagsOfKind(w.db, FLAG_DONE_VS_PLAN)).length, 1, "linking after the fact raises the same flags as linking at once");
  assert.equal((await getTask(w.db, task.taskId))?.status, "in_progress", "status still belongs to the plan");
  assert.equal(await getPendingConfirmation(w.db, w.sender.memberId, NOW), null);
});

test("'@helper bukan' rejects the guess: flags rejected, items stay unlinked, and the work still reaches the candidate queue", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01" });
  await report(w, [{ activity: "kerja lain lagi", matchedTaskId: task.taskId }]);

  const reply = await answerQuery(w.db, queryLlm, w.sender.memberId, "bukan", new Date(NOW.getTime() + 60_000));

  assert.equal(reply.text, "❌ 1 tidak terkait");
  assert.equal((await w.db.select().from(reportItems))[0]?.taskId, null);
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE))[0]?.state, "rejected");
  assert.equal((await listUnresolvedCandidates(w.db)).length, 0, "ADR-0016: a rejected guess no longer becomes a candidate");
  assert.equal(await getPendingConfirmation(w.db, w.sender.memberId, NOW), null);
});

test("an unanswered report question expires after 12 hours, not 30 minutes: a late 'ya' does nothing and the flag stays open for the morning summary", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01" });
  await report(w, [{ activity: "solder", matchedTaskId: task.taskId }]);

  const reply = await answerQuery(w.db, queryLlm, w.sender.memberId, "ya", new Date(NOW.getTime() + 13 * 60 * 60_000));

  assert.equal(reply.text, "Tidak ada yang perlu dikonfirmasi.");
  assert.equal((await w.db.select().from(reportItems))[0]?.taskId, null);
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE))[0]?.state, "open");
});

test("a revised report does not ask again about a match the reporter already confirmed or rejected", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01" });
  await report(w, [{ activity: "solder", matchedTaskId: task.taskId }]);
  await answerQuery(w.db, queryLlm, w.sender.memberId, "ya", new Date(NOW.getTime() + 60_000));

  const { outcome } = await report(w, [{ activity: "solder", matchedTaskId: task.taskId }]);

  if (outcome.status === "report_processed") assert.deepEqual(outcome.plan?.questions, []);
  const items = await w.db.select().from(reportItems);
  assert.ok(items.every((i) => i.taskId === task.taskId), "both revisions' items are linked");
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE)).length, 1);
});

// --- query confirmations keep working ------------------------------------------------

test("a query confirmation and a report match share one pending slot: the latest wins, and 'bukan' still cancels a query", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "1.01" });
  await report(w, [{ activity: "solder", matchedTaskId: task.taskId }]);
  assert.equal((await getPendingConfirmation(w.db, w.sender.memberId, NOW))?.kind, "report_match");

  await setPendingConfirmation(w.db, w.sender.memberId, { intent: "overtime_checkin" }, NOW);
  const pending = await getPendingConfirmation(w.db, w.sender.memberId, NOW);
  assert.equal(pending?.kind, "query");
  assert.equal((await w.db.select().from(pendingConfirmations)).length, 1);
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE))[0]?.state, "open", "the replaced question leaves its flag open");

  const reply = await answerQuery(w.db, queryLlm, w.sender.memberId, "bukan", NOW);
  assert.equal(reply.text, "Oke, dibatalkan.");
  assert.equal(await getPendingConfirmation(w.db, w.sender.memberId, NOW), null);
});

test("a query confirmation still runs on 'ya' exactly as before", async () => {
  const w = await world();
  await setPendingConfirmation(w.db, w.sender.memberId, { intent: "overtime_checkin", timeText: "17:00" }, NOW);

  const reply = await answerQuery(w.db, queryLlm, w.sender.memberId, "ya", NOW);

  assert.match(reply.text, /lembur/i);
  const report = await getDailyReport(w.db, w.sender.memberId, DAY, "overtime");
  assert.ok(report);
});

// --- flags -------------------------------------------------------------------------

test("other_pic: a linked plan task held by someone else is flagged", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "2.01", assignees: [w.other.memberId], picRaw: "Budi" });

  await report(w, [{ matchedTaskId: task.taskId, matchConfidence: "high" }]);

  const [flag] = await flagsOfKind(w.db, FLAG_OTHER_PIC);
  assert.equal((flag?.detail as { planRef: string }).planRef, "aerolift:2.01");
  assert.match((flag?.detail as { note: string }).note, /Budi/);
  assert.equal(flag?.taskId, task.taskId);
  assert.equal(flag?.memberId, w.sender.memberId);
  assert.equal(flag?.state, "open");
});

test("no other_pic when the sender is one of the step's PICs", async () => {
  const w = await world();
  const task = await seedPlanTask(w, { id: "2.01", assignees: [w.other.memberId, w.sender.memberId] });
  await report(w, [{ matchedTaskId: task.taskId, matchConfidence: "high" }]);
  assert.equal((await flagsOfKind(w.db, FLAG_OTHER_PIC)).length, 0);
});

test("done_vs_plan: reported done while the plan is not Selesai; silent when the plan agrees", async () => {
  const w = await world();
  const open = await seedPlanTask(w, { id: "1.01", status: "Berjalan" });
  const closed = await seedPlanTask(w, { id: "1.02", status: "Selesai" });

  await report(w, [
    { activity: "a", status: "done", matchedTaskId: open.taskId, matchConfidence: "high" },
    { activity: "b", status: "done", matchedTaskId: closed.taskId, matchConfidence: "high" },
  ]);

  const flags = await flagsOfKind(w.db, FLAG_DONE_VS_PLAN);
  assert.deepEqual(flags.map((f) => (f.detail as { planRef: string }).planRef), ["aerolift:1.01"]);
  assert.match((flags[0]?.detail as { note: string }).note, /Berjalan/);
  assert.equal((await getTask(w.db, open.taskId))?.status, "in_progress");
});

test("blocked_vs_plan: a blocked status or an obstacle against a plan that is not Blocked; silent when it is", async () => {
  const w = await world();
  const running = await seedPlanTask(w, { id: "1.01", status: "Berjalan" });
  const byObstacle = await seedPlanTask(w, { id: "1.02", status: "Berjalan" });
  const blocked = await seedPlanTask(w, { id: "1.03", status: "Blocked" });

  await report(w, [
    { activity: "a", status: "blocked", matchedTaskId: running.taskId, matchConfidence: "high" },
    { activity: "b", status: "in_progress", obstacle: "menunggu komponen", matchedTaskId: byObstacle.taskId, matchConfidence: "high" },
    { activity: "c", status: "blocked", obstacle: "menunggu komponen", matchedTaskId: blocked.taskId, matchConfidence: "high" },
  ]);

  const flags = await flagsOfKind(w.db, FLAG_BLOCKED_VS_PLAN);
  assert.deepEqual(flags.map((f) => (f.detail as { planRef: string }).planRef).sort(), ["aerolift:1.01", "aerolift:1.02"]);
  assert.match((flags.find((f) => (f.detail as { planRef: string }).planRef === "aerolift:1.02")?.detail as { note: string }).note, /menunggu komponen/);
  assert.equal((await getTask(w.db, running.taskId))?.status, "in_progress", "reporting a block does not block the task");
});

test("early_start: a Belum Mulai step whose start date is after the reporting day; not when it has already started", async () => {
  const w = await world();
  const early = await seedPlanTask(w, { id: "1.01", status: "Belum Mulai", start: "2026-08-10", deadline: "2026-08-14" });
  const onTime = await seedPlanTask(w, { id: "1.02", status: "Belum Mulai", start: "2026-08-07", deadline: "2026-08-14" });

  await report(w, [
    { activity: "a", matchedTaskId: early.taskId, matchConfidence: "high" },
    { activity: "b", matchedTaskId: onTime.taskId, matchConfidence: "high" },
  ]);

  const flags = await flagsOfKind(w.db, FLAG_EARLY_START);
  assert.deepEqual(flags.map((f) => (f.detail as { planRef: string }).planRef), ["aerolift:1.01"]);
  assert.match((flags[0]?.detail as { note: string }).note, /2026-08-10/);
});

test("dependency_open: a referenced plan step that is not Selesai is flagged; free-text and unknown ids are ignored", async () => {
  const w = await world();
  await seedPlanTask(w, { id: "2.01", status: "Berjalan" });
  await seedPlanTask(w, { id: "2.02", status: "Selesai" });
  const dependent = await seedPlanTask(w, { id: "2.03", dependsOn: "2.01, 2.02, 9.99, Tahap 1–3" });
  const allDone = await seedPlanTask(w, { id: "2.04", dependsOn: "2.02" });

  await report(w, [
    { activity: "a", matchedTaskId: dependent.taskId, matchConfidence: "high" },
    { activity: "b", matchedTaskId: allDone.taskId, matchConfidence: "high" },
  ]);

  const flags = await flagsOfKind(w.db, FLAG_DEPENDENCY_OPEN);
  assert.equal(flags.length, 1);
  const detail = flags[0]?.detail as { planRef: string; openDependencies: Array<{ planRef: string }> };
  assert.equal(detail.planRef, "aerolift:2.03");
  assert.deepEqual(detail.openDependencies.map((d) => d.planRef), ["2.01"]);
});

test("no_urgent_work: plan steps due today but none matched — one flag per report, on the first item", async () => {
  const w = await world();
  await seedPlanTask(w, { id: "1.01" });
  await seedPlanTask(w, { id: "1.02" });

  await report(w, [{ activity: "kerjaan lain" }, { activity: "kerjaan lain lagi" }]);

  const flags = await flagsOfKind(w.db, FLAG_NO_URGENT_WORK);
  assert.equal(flags.length, 1);
  const items = await w.db.select().from(reportItems);
  assert.equal(flags[0]?.itemId, items.find((i) => i.activity === "kerjaan lain")?.itemId);
  const detail = flags[0]?.detail as { planRef: string | null; planRefs: string[]; planIds: string[]; activity: string; note: string };
  assert.equal(detail.planRef, null);
  assert.deepEqual(detail.planRefs.sort(), ["aerolift:1.01", "aerolift:1.02"]);
  assert.deepEqual(detail.planIds.sort(), ["1.01", "1.02"]);
  assert.ok(detail.note.length > 0);
});

test("no_urgent_work is not raised when something matched, when nothing is due today, or for an overtime report", async () => {
  const matched = await world();
  const task = await seedPlanTask(matched, { id: "1.01" });
  await report(matched, [{ activity: "x" }, { activity: "y", matchedTaskId: task.taskId, matchConfidence: "high" }]);
  assert.equal((await flagsOfKind(matched.db, FLAG_NO_URGENT_WORK)).length, 0);

  const notDue = await world();
  await seedPlanTask(notDue, { id: "1.01", start: "2026-09-01", deadline: "2026-09-05" });
  await report(notDue, [{ activity: "x" }]);
  assert.equal((await flagsOfKind(notDue.db, FLAG_NO_URGENT_WORK)).length, 0);

  const overtime = await world();
  await seedPlanTask(overtime, { id: "1.01" });
  await report(overtime, [{ activity: "x" }], { text: "laporan lembur\n- pekerjaan: x" });
  assert.equal((await flagsOfKind(overtime.db, FLAG_NO_URGENT_WORK)).length, 0);
});

test("a revised report does not duplicate flags: same report + kind + step is one flag, pointing at the latest revision's item", async () => {
  const w = await world();
  const other = await seedPlanTask(w, { id: "2.01", assignees: [w.other.memberId] });
  const unrelated = await seedPlanTask(w, { id: "1.01" });
  void unrelated;
  const items: Reported[] = [{ activity: "kerjaan lain", status: "done", matchedTaskId: other.taskId, matchConfidence: "high" }];

  await report(w, items);
  await report(w, items);

  const dailyReport = await getDailyReport(w.db, w.sender.memberId, DAY);
  const latest = await getLatestRevision(w.db, dailyReport!.reportId);
  assert.equal(latest?.revisionNumber, 2);
  const [latestItem] = await listItemsForRevision(w.db, latest!.revisionId);

  for (const kind of [FLAG_OTHER_PIC, FLAG_DONE_VS_PLAN]) {
    const flags = await flagsOfKind(w.db, kind);
    assert.equal(flags.length, 1, kind);
    assert.equal(flags[0]?.itemId, latestItem?.itemId, `${kind} follows the latest revision`);
  }
  assert.equal((await allFlags(w.db)).length, 2);
});

test("a revised report does not duplicate no_urgent_work or low_confidence either", async () => {
  const w = await world();
  const unsure = await seedPlanTask(w, { id: "1.01" });
  const other = await seedPlanTask(w, { id: "1.02" });
  void other;

  await report(w, [{ activity: "solder", matchedTaskId: unsure.taskId }]);
  await report(w, [{ activity: "solder", matchedTaskId: unsure.taskId }]);
  assert.equal((await flagsOfKind(w.db, FLAG_LOW_CONFIDENCE)).length, 1);

  const w2 = await world();
  await seedPlanTask(w2, { id: "1.01" });
  await report(w2, [{ activity: "lain" }]);
  await report(w2, [{ activity: "lain" }]);
  assert.equal((await flagsOfKind(w2.db, FLAG_NO_URGENT_WORK)).length, 1);
});

// --- acknowledgment ------------------------------------------------------------------

const planOutcome = (plan: PlanAckData) =>
  ({
    status: "report_processed" as const,
    reportId: "r1",
    summary: { activityCount: 3, taskUpdateCount: 3, taskDoneCount: 0 },
    memberName: "Agas",
    overtime: false,
    plan,
  });
const ref = (id: string, step: string) => ({ title: `BMS Drone: ${step}`, sourceReference: `master-plan-aerolift:${id}` });

test("ack: links are numbered, with a correction hint when there is nothing to ask", () => {
  const text = formatAcknowledgment(
    planOutcome({
      linked: [
        { n: 1, activity: "solder indikator LED", ...ref("1.03", "Soldering PCB indikator LED") },
        { n: 2, activity: "tes fungsi", ...ref("1.04", "Tes fungsi") },
      ],
      questions: [],
    }),
  );
  assert.equal(
    text,
    [
      "✅ *Laporan Agas tercatat*",
      "3 aktivitas · 3 update task",
      "",
      "🔗 *Terkait task urgent*",
      '1. "solder indikator LED" → [1.03] Soldering PCB indikator LED',
      '2. "tes fungsi" → [1.04] Tes fungsi',
      "Salah cocok? Balas *@helper 1 bukan* atau *@helper 1 = 1.04*",
    ].join("\n"),
  );
});

test("ack: links and questions share one numbering, and the hint explains per-number answers", () => {
  const text = formatAcknowledgment(
    planOutcome({
      linked: [{ n: 1, activity: "solder indikator LED", ...ref("1.03", "Soldering PCB indikator LED") }],
      questions: [
        { n: 2, activity: "solder board baterai", task: ref("1.01", "Soldering PCB BMS 4S?") },
        { n: 3, activity: "testing ethernet set 1", task: ref("2.07", "Testing fungsional?") },
      ],
    }),
  );
  assert.equal(
    text,
    [
      "✅ *Laporan Agas tercatat*",
      "3 aktivitas · 3 update task",
      "",
      "🔗 *Terkait task urgent*",
      '1. "solder indikator LED" → [1.03] Soldering PCB indikator LED',
      "",
      "❓ *Cek dulu ya*",
      '2. "solder board baterai" → [1.01] Soldering PCB BMS 4S?',
      '3. "testing ethernet set 1" → [2.07] Testing fungsional?',
      "Balas *@helper ya* kalau semua benar, atau per nomor: *@helper 2 ya 3 bukan* · *@helper 3 = 2.08*",
    ].join("\n"),
  );
});

test("ack: an activity is clipped to 50 characters and the reporter sees no admin-only flag wording", () => {
  const text = formatAcknowledgment(
    planOutcome({ linked: [], questions: [{ n: 1, activity: "x".repeat(100), task: ref("1.01", "Soldering PCB BMS 4S") }] }),
  );
  const line = text?.split("\n").find((l) => l.startsWith("1. ")) ?? "";
  assert.equal(line, `1. "${"x".repeat(49)}…" → [1.01] Soldering PCB BMS 4S`);
  assert.ok(!/PIC|belum Selesai|dependensi/i.test(text ?? ""), "the reporter sees no flag wording");
});

test("ack: a report with no plan data is worded exactly as before", () => {
  const text = formatAcknowledgment({
    status: "report_processed",
    reportId: "r1",
    summary: { activityCount: 1, taskUpdateCount: 0, taskDoneCount: 0 },
    memberName: "Agas",
    overtime: false,
  });
  assert.equal(text, "✅ *Laporan Agas tercatat*\n1 aktivitas");
});
