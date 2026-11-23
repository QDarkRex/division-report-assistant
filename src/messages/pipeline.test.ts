import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { llmInvocations } from "../db/schema.ts";
import { createMember, relinkWhatsappJid, setMemberLevel, setMembershipStatus } from "../members/service.ts";
import { createTask, getTask } from "../tasks/service.ts";
import { addProjectAlias, createProject } from "../projects/service.ts";
import { getDailyReport, getLatestRevision, getOrCreateDailyReport, listItemsForRevision } from "../reports/service.ts";
import { listUnresolvedCandidates } from "../tasks/candidates.ts";
import { isAlreadyProcessed } from "./ingestion.ts";
import { processIncomingMessage, type PipelineDeps } from "./pipeline.ts";
import type { IncomingMessage } from "../whatsapp/connector.ts";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function extractionResponse(data: unknown, usage = { prompt_tokens: 500, completion_tokens: 150 }) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(data) } }], usage });
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const now = new Date("2026-08-07T03:05:00.000Z"); // 10:05 WIB
  return {
    messageId: "wa-msg-1",
    chatJid: "group-1@g.us",
    isGroup: true,
    senderJid: "628111@s.whatsapp.net",
    text: "report\n- pekerjaan: cek panel B",
    messageTimestamp: now,
    receivedAt: now,
    ...overrides,
  };
}

async function makeDeps(db: Awaited<ReturnType<typeof createTestDb>>, fetchImpl: typeof fetch): Promise<PipelineDeps> {
  return { db, llm: { baseUrl: "http://litellm.test", fetchImpl }, now: new Date("2026-08-07T03:05:00.000Z") };
}

// Roadmap Phase 2 exit criteria: message -> classification/extraction -> validated output -> state mutation
test("end-to-end: a report with an unmatched activity creates a report item and no candidate task (ADR-0016)", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return extractionResponse({
      noActivity: false,
      items: [{ activity: "cek panel B", result: "aman", status: "in_progress" }],
    });
  };

  const outcome = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());

  assert.equal(outcome.status, "report_processed");
  assert.equal(calls, 1);
  if (outcome.status === "report_processed") {
    assert.deepEqual(outcome.summary, { activityCount: 1, taskUpdateCount: 0, taskDoneCount: 0 });
    const stored = await getDailyReport(db, member.memberId, "2026-08-07");
    assert.ok(stored);
  }

  assert.deepEqual(await listUnresolvedCandidates(db), []);
});

// The 2026-08-31 backfill filled project_id for history only; nothing set
// it at ingest, so from 2026-09-01 every new item landed NULL and the
// sheet's Proyek column went blank again on the newest tab while older
// tabs stayed populated — worse than never having had the column.
test("an ingested item is attributed to the one project its text names", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");
  const project = await createProject(db, { name: "Drone Alpha" });
  await addProjectAlias(db, project.projectId, "docking Alpha");

  const fetchImpl = async () =>
    extractionResponse({
      noActivity: false,
      items: [{ activity: "melanjutkan wiring docking Alpha", status: "in_progress" }],
    });

  await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());

  const report = await getDailyReport(db, member.memberId, "2026-08-07");
  const revision = await getLatestRevision(db, report!.reportId);
  const [item] = await listItemsForRevision(db, revision!.revisionId);
  assert.equal(item?.projectId, project.projectId);
});

// Ambiguity is a question for a human, not a tie for code to break: the
// owner confirmed 2026-08-31 that lifter and antenna tracker exist in both
// dockings. A wrong attribution surfaces months later as a project total
// nobody can reconcile, so two named projects must leave the item bare.
test("an ingested item naming two projects is left unattributed rather than guessed", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");
  await createProject(db, { name: "Drone Alpha" });
  await createProject(db, { name: "Drone Beta" });

  const fetchImpl = async () =>
    extractionResponse({
      noActivity: false,
      items: [{ activity: "pasang lifter di Drone Alpha dan Drone Beta", status: "in_progress" }],
    });

  await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());

  const report = await getDailyReport(db, member.memberId, "2026-08-07");
  const revision = await getLatestRevision(db, report!.reportId);
  const [item] = await listItemsForRevision(db, revision!.revisionId);
  assert.equal(item?.projectId, null);
});

// A task link has been through a human; a regex match on free text has
// not. When they disagree the reviewed one wins.
test("a matched task's project beats a project named in the item text", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");
  const owning = await createProject(db, { name: "Drone Beta" });
  const named = await createProject(db, { name: "Drone Alpha" });
  const task = await createTask(db, { title: "wiring docking Alpha", projectId: owning.projectId, createdByMemberId: member.memberId });

  const fetchImpl = async () =>
    extractionResponse({
      noActivity: false,
      items: [{ activity: "wiring docking Alpha", status: "in_progress" }],
    });

  await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());

  const report = await getDailyReport(db, member.memberId, "2026-08-07");
  const revision = await getLatestRevision(db, report!.reportId);
  const [item] = await listItemsForRevision(db, revision!.revisionId);
  assert.equal(item?.taskId, task.taskId);
  assert.equal(item?.projectId, owning.projectId, "the task's project, not the one the sentence names");
  assert.notEqual(item?.projectId, named.projectId);
});

test("end-to-end: an activity matching an existing task's title links to it instead of creating a candidate", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  const fetchImpl = async () =>
    extractionResponse({
      noActivity: false,
      items: [{ activity: "cek panel B", status: "in_progress" }],
    });

  const outcome = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());
  assert.equal(outcome.status, "report_processed");
  if (outcome.status === "report_processed") {
    assert.equal(outcome.summary.taskUpdateCount, 1);
  }
  assert.deepEqual(await listUnresolvedCandidates(db), []);
  assert.ok(task.taskId, "sanity: the pre-existing task is what the report item should have linked to");
});

// Found live 2026-08-07: the ack text hardcoded the spec's example name
// "Agas" instead of the actual sender's name — proving this against a
// member NOT named "Agas" (unlike every other test's fixture member) is
// the point; a coincidentally-matching name wouldn't have caught the bug.
test("the outcome carries the actual sender's name, not the spec's example name", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Siti" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const outcome = await processIncomingMessage(
    await makeDeps(db, async () => extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "in_progress" }] })),
    makeMessage(),
  );

  assert.equal(outcome.status, "report_processed");
  if (outcome.status === "report_processed") {
    assert.equal(outcome.memberName, "Siti");
  }
});

// Found 2026-08-07: the pipeline called claimTask() but never transitionStatus() —
// a matched task's status never moved regardless of what the report said.
test("a matched task's status actually transitions based on the report item's status", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });
  assert.equal((await getTask(db, task.taskId))?.status, "active");

  await processIncomingMessage(
    await makeDeps(db, async () => extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "in_progress" }] })),
    makeMessage({ messageId: "wa-msg-day1" }),
  );
  assert.equal((await getTask(db, task.taskId))?.status, "in_progress", "worked_on/in_progress should move active -> in_progress");

  await processIncomingMessage(
    await makeDeps(db, async () => extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "done" }] })),
    makeMessage({ messageId: "wa-msg-day2", text: "report\n- cek panel B selesai" }),
  );
  assert.equal((await getTask(db, task.taskId))?.status, "done", "done should move in_progress -> done");
});

test("a report status with no valid transition from the task's current status does not throw or block the report", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  // obstacle_reported is only valid from in_progress — this task is still "active".
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  const outcome = await processIncomingMessage(
    await makeDeps(db, async () => extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "blocked" }] })),
    makeMessage(),
  );

  assert.equal(outcome.status, "report_processed");
  assert.equal((await getTask(db, task.taskId))?.status, "active", "invalid transition is a silent no-op, task status unchanged");
});

// "test docking charge" is testing, not done (ACCEPTANCE_TESTS.md §2.2) — proven end to end through the real LLM contract
test("status distinctions from the LLM survive Zod validation and land in the stored report item", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const fetchImpl = async () =>
    extractionResponse({
      noActivity: false,
      items: [{ activity: "test docking charge", result: "charging berhasil", status: "testing" }],
    });

  const outcome = await processIncomingMessage(
    await makeDeps(db, fetchImpl),
    makeMessage({ text: "report\n- pekerjaan: test docking charge" }),
  );
  assert.equal(outcome.status, "report_processed");

  assert.deepEqual(await listUnresolvedCandidates(db), []);
});

// d2 (obstacle categorization)
test("an obstacleCategory from the LLM is persisted on the stored report item", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const fetchImpl = async () =>
    extractionResponse({
      noActivity: false,
      items: [{ activity: "cek panel B", status: "blocked", obstacle: "kabel putus", obstacleCategory: "hardware_issue" }],
    });

  const outcome = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());
  assert.equal(outcome.status, "report_processed");

  const report = await getDailyReport(db, member.memberId, "2026-08-07");
  assert.ok(report);
  const revision = await getLatestRevision(db, report.reportId);
  assert.ok(revision);
  const items = await listItemsForRevision(db, revision.revisionId);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.obstacleCategory, "hardware_issue");
});

test("an item with no obstacle leaves obstacleCategory null, not defaulted to 'none'", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const fetchImpl = async () => extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "in_progress" }] });
  await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());

  const report = await getDailyReport(db, member.memberId, "2026-08-07");
  assert.ok(report);
  const revision = await getLatestRevision(db, report.reportId);
  assert.ok(revision);
  const items = await listItemsForRevision(db, revision.revisionId);
  assert.equal(items[0]?.obstacleCategory, null);
});

// ACCEPTANCE_TESTS.md §2.3
test("a no-activity report is stored without calling the task-matching path", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const fetchImpl = async () => extractionResponse({ noActivity: true, items: [] });

  const outcome = await processIncomingMessage(
    await makeDeps(db, fetchImpl),
    makeMessage({ text: "report\nTidak ada aktivitas hari ini" }),
  );

  assert.equal(outcome.status, "report_no_activity");
  const stored = await getDailyReport(db, member.memberId, "2026-08-07");
  assert.equal(stored?.noActivity, true);
  assert.equal(stored?.pendingAdminConfirmation, true);
});

// ACCEPTANCE_TESTS.md §4.1 dedup, at the pipeline level
test("a duplicate message id is processed exactly once, LLM is not called twice", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "in_progress" }] });
  };

  const deps = await makeDeps(db, fetchImpl);
  const first = await processIncomingMessage(deps, makeMessage());
  const second = await processIncomingMessage(deps, makeMessage());

  assert.equal(first.status, "report_processed");
  assert.equal(second.status, "duplicate");
  assert.equal(calls, 1);
});

test("a reconnect-replayed message is stored but never reaches the LLM", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return extractionResponse({ noActivity: false, items: [] });
  };

  const messageTimestamp = new Date("2026-08-07T00:00:00.000Z");
  const receivedAt = new Date("2026-08-07T03:05:00.000Z"); // hours later -> replay
  const outcome = await processIncomingMessage(
    await makeDeps(db, fetchImpl),
    makeMessage({ messageTimestamp, receivedAt }),
  );

  assert.equal(outcome.status, "replayed");
  assert.equal(calls, 0, "LLM must never be called for a replayed message");
  assert.equal(await isAlreadyProcessed(db, "wa-msg-1"), true, "still recorded as processed, for dedup/audit");
});

test("an unrecognized sender's message is stored but not processed", async () => {
  const db = await createTestDb();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return extractionResponse({ noActivity: false, items: [] });
  };

  const outcome = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());
  assert.equal(outcome.status, "unrecognized_sender");
  assert.equal(calls, 0);
});

// §4.5 item 3: obvious non-report content produces zero LLM calls
test("a message without a report header never reaches the LLM — stored as candidate context instead", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return extractionResponse({ noActivity: false, items: [] });
  };

  const outcome = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage({ text: "halo semua, ada info penting" }));
  assert.equal(outcome.status, "stored_as_context");
  assert.equal(calls, 0);
});

// Found live 2026-08-08: DeepSeek exhausted 3 repair attempts on an
// otherwise-normal report (missing the required noActivity field) and the
// message was silently dropped — no ack, no error visible to the sender.
test("an LLM extraction failure returns a distinguishable outcome instead of throwing", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Riko" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  // A wrong-TYPED items value on every attempt, including repairs. (A merely
  // MISSING field no longer fails: since 2026-08-12 both top-level fields
  // default, because every real-world failure so far was DeepSeek omitting
  // one and losing a real report. Defaults cover omission, not garbage.)
  const fetchImpl = async () => extractionResponse({ items: "bukan array" });

  const outcome = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());

  assert.equal(outcome.status, "report_extraction_failed");
  if (outcome.status === "report_extraction_failed") {
    assert.equal(outcome.memberName, "Riko");
  }
});

// 2026-08-10: the catch above was `catch {}`, so a failure left no row at
// all — the live table had only successes, making the real failure rate
// (and the tokens those failures burned) unmeasurable.
test("an LLM extraction failure still records an llm_invocations row, with a reason and the tokens it burned", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Riko" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const fetchImpl = async () => extractionResponse({ items: "bukan array" });
  await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());

  const rows = await db.select().from(llmInvocations);
  assert.equal(rows.length, 1, "a failed call must be recorded exactly once, same as a successful one");
  assert.equal(rows[0]?.feature, "report_extraction");
  assert.ok(rows[0]?.failureReason, "the reason must be recorded, not discarded");
  assert.ok(
    (rows[0]?.promptTokens ?? 0) > 0,
    "tokens burned across the failed attempts must count toward the budget, not vanish",
  );
});

test("a message that failed LLM extraction is still marked processed (known limitation: cannot be auto-retried, sender must resend)", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Riko" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  await processIncomingMessage(
    await makeDeps(db, async () => extractionResponse({ items: "bukan array" })),
    makeMessage(),
  );

  assert.equal(await isAlreadyProcessed(db, "wa-msg-1"), true);
});

test("an @helper query is answered without reaching the report-extraction path", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const fetchImpl = async () => extractionResponse({ intent: "missing_reporters" });
  const outcome = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage({ text: "@helper siapa yang belum report?" }));

  assert.equal(outcome.status, "query_answered");
  if (outcome.status === "query_answered") {
    assert.match(outcome.replyText, /lapor/);
  }
});

test("a report header takes precedence over an @helper mention in the same message", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const fetchImpl = async () => extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "in_progress" }] });
  const outcome = await processIncomingMessage(
    await makeDeps(db, fetchImpl),
    makeMessage({ text: "report\n@helper cek panel B" }),
  );

  assert.equal(outcome.status, "report_processed");
});

// ---------------------------------------------------------------------
// External audit findings, 2026-09-08. All three cost a member their
// report silently, which is the failure mode this system keeps producing.
// ---------------------------------------------------------------------

test("a report that fails mid-processing is NOT marked processed, so a redelivery still lands", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  let attempt = 0;
  const fetchImpl = async () => {
    attempt++;
    if (attempt === 1) throw new Error("gateway exploded");
    return extractionResponse({ noActivity: false, items: [{ activity: "cek panel B", status: "done" }] });
  };

  const first = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());
  assert.equal(first.status, "report_extraction_failed");
  assert.equal(await isAlreadyProcessed(db, "wa-msg-1"), false, "a failed attempt must stay retryable");

  // Baileys redelivering the same event after a reconnect. Before
  // 2026-09-08 this returned "duplicate" and the report was gone for good.
  const second = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());
  assert.equal(second.status, "report_processed");
  assert.equal(await isAlreadyProcessed(db, "wa-msg-1"), true);
});

test("two reports for the same member and day racing each other both survive", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  // getOrCreateDailyReport was SELECT-then-INSERT. Members really do send
  // the same report twice seconds apart, and the connector dispatches
  // without awaiting, so both calls saw no row and both inserted; the
  // loser threw on the unique index and its message was already marked
  // processed.
  const [a, b] = await Promise.all([
    getOrCreateDailyReport(db, member.memberId, "2026-08-07"),
    getOrCreateDailyReport(db, member.memberId, "2026-08-07"),
  ]);
  assert.equal(a.reportId, b.reportId, "both callers must end up on the same report");
});

test("a member correcting 'tidak ada aktivitas' with real work clears the flag", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, "628111@s.whatsapp.net");

  const responses = [
    extractionResponse({ noActivity: true, items: [] }),
    extractionResponse({ noActivity: false, items: [{ activity: "ternyata ada: cek panel B", status: "done" }] }),
  ];
  let call = 0;
  const fetchImpl = async () => responses[call++]!;

  await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage({ messageId: "wa-none" }));
  const afterNoActivity = await getDailyReport(db, member.memberId, "2026-08-07");
  assert.equal(afterNoActivity?.noActivity, true);

  await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage({ messageId: "wa-correction", text: "report\n- ternyata ada: cek panel B" }));

  // Without the fix the revision and its item were stored and then hidden:
  // the date tab checks noActivity before rendering anything below it, so
  // the correction read "— tidak ada aktivitas —" forever.
  const corrected = await getDailyReport(db, member.memberId, "2026-08-07");
  assert.equal(corrected?.noActivity, false);
  assert.equal(corrected?.pendingAdminConfirmation, false);

  const revision = await getLatestRevision(db, corrected!.reportId);
  const items = await listItemsForRevision(db, revision!.revisionId);
  assert.equal(items.length, 1);
});

// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Overtime (lembur) routing, 2026-09-11. Which report a member's work
// lands in — regular or overtime — is decided before the LLM call, from
// the header and the owner's Saturday rule. Never by the model.
// ---------------------------------------------------------------------

async function activeMemberFor(db: Awaited<ReturnType<typeof createTestDb>>, name: string, jid: string) {
  const m = await createMember(db, { preferredName: name });
  await setMembershipStatus(db, m.memberId, "active");
  await relinkWhatsappJid(db, m.memberId, jid);
  return m;
}

test("an overtime-headed report is stored as the overtime report, separate from the regular one", async () => {
  const db = await createTestDb();
  const m = await activeMemberFor(db, "Agas", "628111@s.whatsapp.net");
  const fetchImpl = async () => extractionResponse({ noActivity: false, items: [{ activity: "solder PCB tambahan", status: "done" }] });

  const out = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage({ text: "Report lembur\n- solder PCB tambahan" }));
  assert.equal(out.status, "report_processed");
  if (out.status === "report_processed") assert.equal(out.overtime, true);

  assert.ok(await getDailyReport(db, m.memberId, "2026-08-07", "overtime"), "overtime report exists");
  assert.equal(await getDailyReport(db, m.memberId, "2026-08-07", "regular"), null, "and it did NOT land in the regular report");
});

test("a regular report is untouched by the overtime path", async () => {
  const db = await createTestDb();
  const m = await activeMemberFor(db, "Agas", "628111@s.whatsapp.net");
  const fetchImpl = async () => extractionResponse({ noActivity: false, items: [{ activity: "wiring docking", status: "in_progress" }] });

  const out = await processIncomingMessage(await makeDeps(db, fetchImpl), makeMessage());
  if (out.status === "report_processed") assert.equal(out.overtime, false);
  assert.ok(await getDailyReport(db, m.memberId, "2026-08-07", "regular"));
  assert.equal(await getDailyReport(db, m.memberId, "2026-08-07", "overtime"), null);
});

// 2026-09-05 is a Saturday. Owner rule: staff-and-above who work a Saturday
// are on overtime by definition, even with a plain "Report" header.
const SATURDAY_NOON_WIB = new Date("2026-09-05T05:00:00.000Z");

test("a staff member reporting on a Saturday is routed to overtime automatically", async () => {
  const db = await createTestDb();
  const m = await activeMemberFor(db, "Rendi", "628111@s.whatsapp.net");
  await setMemberLevel(db, m.memberId, "staff");
  const fetchImpl = async () => extractionResponse({ noActivity: false, items: [{ activity: "beberes lab", status: "done" }] });

  const deps = { db, llm: { baseUrl: "http://litellm.test", fetchImpl }, now: SATURDAY_NOON_WIB };
  const out = await processIncomingMessage(deps, makeMessage({ text: "Report Rendi\n- beberes lab", messageTimestamp: SATURDAY_NOON_WIB, receivedAt: SATURDAY_NOON_WIB }));
  if (out.status === "report_processed") assert.equal(out.overtime, true, "plain Saturday report from staff is overtime");
  assert.ok(await getDailyReport(db, m.memberId, "2026-09-05", "overtime"));
});

test("a magang reporting on a Saturday stays regular — Saturday is their normal day", async () => {
  const db = await createTestDb();
  const m = await activeMemberFor(db, "Wawan", "628111@s.whatsapp.net");
  const fetchImpl = async () => extractionResponse({ noActivity: false, items: [{ activity: "solder", status: "done" }] });

  const deps = { db, llm: { baseUrl: "http://litellm.test", fetchImpl }, now: SATURDAY_NOON_WIB };
  const out = await processIncomingMessage(deps, makeMessage({ text: "Report Wawan\n- solder", messageTimestamp: SATURDAY_NOON_WIB, receivedAt: SATURDAY_NOON_WIB }));
  if (out.status === "report_processed") assert.equal(out.overtime, false);
  assert.ok(await getDailyReport(db, m.memberId, "2026-09-05", "regular"));
});

test("a member can file a regular AND an overtime report on the same day", async () => {
  const db = await createTestDb();
  const m = await activeMemberFor(db, "Agas", "628111@s.whatsapp.net");
  const reg = async () => extractionResponse({ noActivity: false, items: [{ activity: "wiring docking", status: "in_progress" }] });
  const ot = async () => extractionResponse({ noActivity: false, items: [{ activity: "lanjut solder malam", status: "done" }] });

  await processIncomingMessage(await makeDeps(db, reg), makeMessage({ messageId: "wa-reg", text: "Report Agas\n- wiring docking" }));
  await processIncomingMessage(await makeDeps(db, ot), makeMessage({ messageId: "wa-ot", text: "Report lembur\n- lanjut solder malam" }));

  assert.ok(await getDailyReport(db, m.memberId, "2026-08-07", "regular"));
  assert.ok(await getDailyReport(db, m.memberId, "2026-08-07", "overtime"));
});

// ---------------------------------------------------------------------
// Telling an unregistered number their report didn't land (2026-09-17).
// Rafi reported for days before he was added and got total silence. Now a
// report attempt from inside the GROUP earns a hint — but a DM stays quiet
// (never confirm a bot to a stranger) and casual chatter is not nagged.
// ---------------------------------------------------------------------

test("an unregistered number posting a report in the group is told to register", async () => {
  const db = await createTestDb();
  // Nobody is created — the sender resolves to no member.
  const out = await processIncomingMessage(
    await makeDeps(db, async () => { throw new Error("LLM must not be called for an unknown sender"); }),
    makeMessage({ isGroup: true, text: "Report Someone\n- solder pcb" }),
  );
  assert.equal(out.status, "unrecognized_sender");
  if (out.status === "unrecognized_sender") assert.equal(out.promptRegister, true);
});

test("an unregistered number in a direct chat stays silent", async () => {
  const db = await createTestDb();
  const out = await processIncomingMessage(
    await makeDeps(db, async () => { throw new Error("LLM must not be called"); }),
    makeMessage({ isGroup: false, text: "Report Someone\n- solder pcb" }),
  );
  assert.equal(out.status, "unrecognized_sender");
  if (out.status === "unrecognized_sender") assert.equal(out.promptRegister, false);
});

test("an unregistered number's casual group chatter is not nagged", async () => {
  const db = await createTestDb();
  const out = await processIncomingMessage(
    await makeDeps(db, async () => { throw new Error("LLM must not be called"); }),
    makeMessage({ isGroup: true, text: "halo semua apa kabar" }),
  );
  assert.equal(out.status, "unrecognized_sender");
  if (out.status === "unrecognized_sender") assert.equal(out.promptRegister, false);
});
