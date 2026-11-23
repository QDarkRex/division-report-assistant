import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { formatDeadlineReminderText, registerScheduledJobs } from "./scheduler.ts";
import { createTestDb } from "../db/testing.ts";
import { createMember, relinkWhatsappJid, setMembershipStatus } from "../members/service.ts";
import { assignMember, createTask } from "../tasks/service.ts";
import { computeMustFinishBefore } from "../tasks/deadline.ts";
import type { Task } from "../tasks/types.ts";
import { addCalendarDays, calendarDayOf } from "../shared/time.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { createCandidateTask, listUnresolvedCandidates } from "../tasks/candidates.ts";
import { dailySummaries, llmInvocations, tasks, weeklyRecaps, weeklySummaries } from "../db/schema.ts";
import { seedBriefWorld } from "../brief/testing.ts";

/**
 * Real pg-boss enforces schedule.name/job.name as a foreign key onto
 * queue.name — schedule()/work() throw if createQueue() wasn't called
 * first. This fake reproduces that constraint so the bug found deploying
 * against a real Postgres (2026-08-07: "Queue wdh.morning-summary not
 * found") can't silently reappear — a fake boss that accepts schedule()
 * unconditionally would never catch it.
 */
function fakeBoss() {
  const queues = new Set<string>();
  const scheduled: string[] = [];
  const unscheduled: string[] = [];
  const worked: string[] = [];
  const handlers = new Map<string, () => Promise<void>>();

  return {
    createQueue: async (name: string) => {
      queues.add(name);
    },
    schedule: async (name: string) => {
      if (!queues.has(name)) throw new Error(`Queue ${name} not found`);
      scheduled.push(name);
    },
    unschedule: async (name: string) => {
      unscheduled.push(name);
    },
    work: async (name: string, handler: () => Promise<void>) => {
      if (!queues.has(name)) throw new Error(`Queue ${name} not found`);
      worked.push(name);
      handlers.set(name, handler);
    },
    scheduled,
    unscheduled,
    worked,
    handlers,
  };
}

test("registerScheduledJobs creates every queue before scheduling or working it", async () => {
  const boss = fakeBoss();
  const db = {} as never;

  await registerScheduledJobs({ db, boss: boss as never, sendGroupText: async () => {} });

  assert.equal(boss.scheduled.length, 9);
  assert.equal(boss.worked.length, 9);
});

// Turned off 2026-09-01 after producing 242 tasks (all cancelled) and then
// 28 more the next morning. Asserting on unschedule() rather than just on
// absence: pg-boss keeps schedules in the database, so dropping the
// schedule() call alone would leave the old cron row firing against a queue
// with no worker — the job would look gone from the code and still be live
// in production.
test("candidate auto-promotion is unscheduled, not merely left unregistered", async () => {
  const boss = fakeBoss();

  await registerScheduledJobs({ db: {} as never, boss: boss as never, sendGroupText: async () => {} });

  assert.deepEqual(boss.unscheduled, ["wdh.candidate-promotion"]);
  assert.ok(!boss.scheduled.includes("wdh.candidate-promotion"));
  assert.ok(!boss.worked.includes("wdh.candidate-promotion"));
});

// ADR-0016: candidate tasks are frozen; the morning job no longer counts them.
test("running the morning-summary job leaves candidate shown counts alone", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const revision = await addRevision(db, report.reportId, "report\n- ganti sekring panel B");
  const item = await addReportItem(db, revision.revisionId, { activity: "ganti sekring panel B" });
  await createCandidateTask(db, { reportItemId: item.itemId, createdByMemberId: member.memberId, suggestedTitle: "Ganti sekring panel B" });

  const boss = fakeBoss();
  const sentTexts: string[] = [];
  await registerScheduledJobs({ db, boss: boss as never, sendGroupText: async (text) => void sentTexts.push(text) });
  const morningSummaryHandler = boss.handlers.get("wdh.morning-summary");
  assert.ok(morningSummaryHandler, "morning-summary handler must be registered");
  await morningSummaryHandler();

  assert.equal(sentTexts.length, 1, "morning summary text should still be sent");
  const [untouched] = await listUnresolvedCandidates(db);
  assert.equal(untouched?.summariesShownCount, 0);
});

test("the sheets-sync and reports-sync jobs are registered only when sheetsSync config is present", async () => {
  const boss = fakeBoss();
  const db = {} as never;
  await registerScheduledJobs({ db, boss: boss as never, sendGroupText: async () => {} });
  assert.ok(!boss.worked.includes("wdh.sheets-sync"), "must not register the job when not configured");
  assert.ok(!boss.worked.includes("wdh.reports-sync"), "must not register the job when not configured");
});

test("the sheets-sync and reports-sync jobs ARE registered when sheetsSync config is present", async () => {
  const boss = fakeBoss();
  const db = {} as never;
  await registerScheduledJobs({
    db,
    boss: boss as never,
    sendGroupText: async () => {},
    sheetsSync: { sheets: {} as never, spreadsheetId: "sheet-1" },
  });
  assert.ok(boss.worked.includes("wdh.sheets-sync"));
  assert.ok(boss.worked.includes("wdh.reports-sync"));
  // Added 2026-09-04: hourly alone left a member invisible in the sheet
  // for up to 54 minutes after reporting, which reads as "not recorded".
  assert.ok(boss.worked.includes("wdh.reports-sync-evening"));
  // Added 2026-09-08: hourly TASKS sync made assigning work in the sheet
  // look like it had not worked when the bot was asked a minute later.
  assert.ok(boss.worked.includes("wdh.sheets-sync-frequent"));
  assert.equal(boss.scheduled.length, 13, "four more scheduled jobs than the baseline 9");
});

// ADR-0016: the Saturday summary no longer goes to the group (the Sunday recap
// replaces it); both runs still persist it for the sheet.
test("neither weekly summary run sends to WhatsApp, both still persist", async () => {
  const db = await createTestDb();
  const boss = fakeBoss();
  const sentTexts: string[] = [];
  await registerScheduledJobs({ db, boss: boss as never, sendGroupText: async (text) => void sentTexts.push(text) });

  const provisionalHandler = boss.handlers.get("wdh.weekly-summary-provisional");
  const finalHandler = boss.handlers.get("wdh.weekly-summary-final");
  assert.ok(provisionalHandler && finalHandler);

  await provisionalHandler();
  assert.equal(sentTexts.length, 0, "provisional persists but no longer sends");
  assert.equal((await db.select().from(weeklySummaries)).length, 1);

  await finalHandler();
  assert.equal(sentTexts.length, 0, "final must not send either");

  const rows = await db.select().from(weeklySummaries);
  assert.equal(rows.length, 1, "final upserts onto the SAME weekStart row, not a second one");
  assert.equal(rows[0]?.provisional, false, "final overwrites provisional=true with false");
});

test("the weekly recap job is scheduled for Sunday 19:00 Jakarta and sends the fallback when no LLM is configured", async () => {
  const db = await createTestDb();
  const schedules: Array<[string, string, unknown]> = [];
  const boss = fakeBoss();
  const origSchedule = boss.schedule;
  boss.schedule = (async (name: string, cron: string, _data: unknown, opts: unknown) => {
    schedules.push([name, cron, opts]);
    return origSchedule(name);
  }) as never;
  const sent: string[] = [];
  await registerScheduledJobs({ db, boss: boss as never, sendGroupText: async (text) => void sent.push(text) });

  assert.deepEqual(schedules.find(([n]) => n === "wdh.weekly-recap"), ["wdh.weekly-recap", "0 19 * * 0", { tz: "Asia/Jakarta" }]);
  await boss.handlers.get("wdh.weekly-recap")!();
  assert.equal(sent.length, 1, "something is always sent");
  assert.ok((sent[0] ?? "").startsWith("*REKAP MINGGUAN DIVISI EE*"));
  assert.equal((await db.select().from(weeklyRecaps)).length, 1);
});

test("formatDeadlineReminderText is a title with a count, then the tasks as bullets", () => {
  const text = formatDeadlineReminderText([
    { title: "Cek panel B", sourceReference: null },
    { title: "Gimbal: kalibrasi sumbu pitch", sourceReference: "master-plan-aerolift:G4" },
  ] as Task[]);
  assert.equal(text, "⏰ *Jatuh tempo hari ini* — 2 task\n\n• Cek panel B\n• [G4] kalibrasi sumbu pitch");
});

test("the 16:00 deadline reminder tags the assignees on their own line, and the tag still reaches the mentions array", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");
  await relinkWhatsappJid(db, budi.memberId, "111@lid");
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });
  await assignMember(db, task.taskId, budi.memberId);
  // Label day = tomorrow, i.e. "finish by today".
  await db
    .update(tasks)
    .set({ mustFinishBefore: computeMustFinishBefore(addCalendarDays(calendarDayOf(new Date()), 1)) })
    .where(eq(tasks.taskId, task.taskId));

  const boss = fakeBoss();
  const mentions: Array<{ text: string; jids: string[] }> = [];
  await registerScheduledJobs({
    db,
    boss: boss as never,
    sendGroupText: async () => {},
    sendGroupMention: async (text, jids) => void mentions.push({ text, jids }),
  });
  const handler = boss.handlers.get("wdh.deadline-reminder");
  assert.ok(handler);
  await handler();

  assert.deepEqual(mentions, [{ text: "⏰ *Jatuh tempo hari ini* — 1 task\n\n• Cek panel B\n\n@111", jids: ["111@lid"] }]);
});

// The brief's LLM step is a nicety: when the gateway is down the group still
// gets the facts at 08:00, and the failed call is on the books.
test("the morning brief job sends the facts without the model's sections when the LLM call throws", async () => {
  const { db } = await seedBriefWorld();
  const boss = fakeBoss();
  const sent: string[] = [];
  const fetchImpl = (async () => {
    throw new Error("gateway down");
  }) as unknown as typeof fetch;
  await registerScheduledJobs({
    db,
    boss: boss as never,
    sendGroupText: async (text) => void sent.push(text),
    morningBrief: { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m" },
  });

  const handler = boss.handlers.get("wdh.morning-summary");
  assert.ok(handler);
  await handler();

  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /^☀️ \*Rangkuman Pagi\*/);
  assert.match(sent[0] ?? "", /\*Aerolift Drone Mobil\* — progress \d+%/);
  assert.doesNotMatch(sent[0] ?? "", /Prioritas hari ini/);
  assert.match(sent[0] ?? "", /\*Hambatan & saran\*\n• ⚠️ \[6\.02\]/, "the raw blocker is still listed, without advice");
  const invocations = await db.select().from(llmInvocations);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.feature, "scheduled_summary");
  assert.match(invocations[0]?.failureReason ?? "", /gateway down/);
  const [stored] = await db.select().from(dailySummaries);
  assert.ok(stored?.sentAt, "the brief is remembered even without the model");
  assert.equal((stored?.content as { llmError: string }).llmError, "gateway down");
});

test("the morning brief job adds the model's sections when the call works, and remembers the whole brief", async () => {
  const { db } = await seedBriefWorld();
  const boss = fakeBoss();
  const sent: string[] = [];
  const answer = {
    ringkasan: "Konektor XT90 masih menahan pengadaan.",
    prioritas: [{ planRef: "6.02", alasan: "tanpa konektor perakitan berhenti" }],
    hambatan: [{ planRef: "aerolift:6.02", masalah: "supplier belum konfirmasi", saran: "Bagas minta ETA tertulis hari ini", pic: "Bagas" }],
  };
  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }),
      text: async () => "",
    }) as Response) as typeof fetch;
  await registerScheduledJobs({
    db,
    boss: boss as never,
    sendGroupText: async (text) => void sent.push(text),
    morningBrief: { llm: { baseUrl: "http://llm.test", fetchImpl }, model: "m" },
  });

  await boss.handlers.get("wdh.morning-summary")!();

  assert.match(sent[0] ?? "", /\*Prioritas hari ini\*\n• \[6\.02\] Pengadaan konektor XT90 — tanpa konektor perakitan berhenti/);
  // The advice already starts with the PIC's name, so it is not repeated in brackets.
  assert.match(sent[0] ?? "", /→ Bagas minta ETA tertulis hari ini$/m);
  const [stored] = await db.select().from(dailySummaries);
  const content = stored?.content as { kind: string; text: string; llm: { prioritas: unknown[] }; facts: { plan: unknown } };
  assert.equal(content.kind, "morning_brief");
  assert.equal(content.text, sent[0]);
  assert.equal(content.llm.prioritas.length, 1);
  assert.ok(content.facts.plan);
  assert.equal((await db.select().from(llmInvocations)).length, 1);
});

test("without an LLM configured the morning brief job still sends; candidates are no longer counted", async () => {
  const { db } = await seedBriefWorld();
  const boss = fakeBoss();
  const sent: string[] = [];
  await registerScheduledJobs({ db, boss: boss as never, sendGroupText: async (text) => void sent.push(text) });

  await boss.handlers.get("wdh.morning-summary")!();

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0] ?? "", /Prioritas hari ini/);
  assert.doesNotMatch(sent[0] ?? "", /kandidat/);
  assert.deepEqual(await listUnresolvedCandidates(db), []);
  assert.equal((await db.select().from(llmInvocations)).length, 0);
});
