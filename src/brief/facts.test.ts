import assert from "node:assert/strict";
import { test } from "node:test";
import { dailySummaries, planItemChanges } from "../db/schema.ts";
import { createTestDb } from "../db/testing.ts";
import { fromJakartaWallClock } from "../shared/time.ts";
import { buildMorningBriefFacts, describePlanChange, resolveBriefSince, resolvePlanRef } from "./facts.ts";
import { BRIEF_NOW, EXPECTED, seedBriefWorld } from "./testing.ts";

test("plan facts: progress, status counts and areas skip the step the sheet no longer has", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);

  assert.equal(facts.today, "2026-10-03");
  assert.ok(facts.plan);
  assert.equal(facts.plan.projectName, "Aerolift Drone Mobil");
  assert.equal(facts.plan.itemCount, EXPECTED.itemCount);
  assert.equal(facts.plan.overallProgressPct, EXPECTED.overallProgressPct);
  assert.deepEqual(facts.plan.statusCounts, { Berjalan: 4, "Belum Mulai": 2, Selesai: 2, Blocked: 1 });
  assert.deepEqual(facts.plan.areas.find((a) => a.area === "BMS"), { area: "BMS", items: 2, progressPct: 20 });
  assert.ok(!("aerolift:7.01" in facts.plan.labels), "a missing step is not part of the plan any more");
});

test("overdue, due today, due tomorrow and starting today follow the inclusive plan deadline in Jakarta time", async () => {
  const { db } = await seedBriefWorld();
  const { plan } = await buildMorningBriefFacts(db, BRIEF_NOW);
  assert.ok(plan);

  assert.deepEqual(plan.overdue.map((o) => o.planRef), EXPECTED.overdueRefs);
  assert.deepEqual(plan.overdue.map((o) => o.daysLate), EXPECTED.daysLate);
  assert.deepEqual(plan.overdue[0]?.pic, ["Bagas"]);
  assert.deepEqual(plan.dueToday.map((o) => o.planRef), EXPECTED.dueTodayRefs);
  assert.deepEqual(plan.dueTomorrow.map((o) => o.planRef), EXPECTED.dueTomorrowRefs);
  assert.deepEqual(plan.startingToday.map((o) => o.planRef), EXPECTED.startingTodayRefs);
  assert.ok(!plan.overdue.some((o) => o.planRef === "aerolift:2.01"), "a finished step is never late");
});

test("a step due today is not overdue at 23:59 Jakarta, and is the next morning", async () => {
  const { db } = await seedBriefWorld();
  const evening = await buildMorningBriefFacts(db, fromJakartaWallClock(2026, 10, 3, 23, 59));
  const morning = await buildMorningBriefFacts(db, fromJakartaWallClock(2026, 10, 4, 8, 0));

  assert.ok(!evening.plan?.overdue.some((o) => o.planRef === "aerolift:3.07"));
  assert.equal(morning.plan?.overdue.find((o) => o.planRef === "aerolift:3.07")?.daysLate, 1);
});

test("plan changes since the previous brief are grouped per step and written as old to new", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);

  assert.deepEqual(
    facts.planChanges.map((g) => [g.id, g.changes.map((c) => c.text)]),
    [
      ["3.08", ["deadline Sab, 3 Okt → Min, 4 Okt"]],
      ["5.02", ["Berjalan → Selesai", "progress 50% → 100%"]],
    ],
  );
  assert.equal(facts.sinceSource, "default");
  assert.equal(facts.since, new Date(BRIEF_NOW.getTime() - 24 * 3600 * 1000).toISOString());
});

test("describePlanChange covers every field the sync records", () => {
  assert.equal(describePlanChange("added", null, "BMS: Langkah"), "langkah baru ditambahkan");
  assert.equal(describePlanChange("removed", "BMS: Langkah", null), "dihapus dari plan");
  assert.equal(describePlanChange("pic", "Bagas", "Wisnu"), "PIC Bagas → Wisnu");
  assert.equal(describePlanChange("pic_unresolved", null, "Budi"), 'PIC "Budi" belum dikenali');
  assert.equal(describePlanChange("start", "2026-10-01", null), "mulai Kam, 1 Okt → -");
});

test("on a Monday with no earlier brief the window reaches back to Saturday 08:00", async () => {
  const db = await createTestDb();
  const { since, source } = await resolveBriefSince(db, fromJakartaWallClock(2026, 10, 5, 8, 0));
  assert.equal(source, "default");
  assert.equal(since.toISOString(), fromJakartaWallClock(2026, 10, 3, 8, 0).toISOString());
});

test("Monday: a change made on Sunday shows up, one made before Saturday 08:00 does not", async () => {
  const { db, taskIds } = await seedBriefWorld();
  await db.insert(planItemChanges).values([
    { planRef: "aerolift:4.03", taskId: taskIds["4.03"]!, field: "progress", oldValue: "10%", newValue: "30%", detectedAt: fromJakartaWallClock(2026, 10, 4, 15, 0) },
    { planRef: "aerolift:4.04", taskId: taskIds["4.04"]!, field: "progress", oldValue: "0%", newValue: "10%", detectedAt: fromJakartaWallClock(2026, 10, 3, 7, 59) },
  ]);
  const facts = await buildMorningBriefFacts(db, fromJakartaWallClock(2026, 10, 5, 8, 0));
  assert.deepEqual(facts.planChanges.map((g) => g.id), ["4.03"]);
});

test("the previous brief's send time is the window start when one was persisted, and never older than a week", async () => {
  const db = await createTestDb();
  const sent = fromJakartaWallClock(2026, 10, 1, 8, 0, 5);
  await db.insert(dailySummaries).values({ summaryDay: "2026-10-01", content: {}, sentAt: sent });

  const next = await resolveBriefSince(db, fromJakartaWallClock(2026, 10, 3, 8, 0));
  assert.equal(next.source, "previous_brief");
  assert.equal(next.since.toISOString(), sent.toISOString());

  const farLater = await resolveBriefSince(db, fromJakartaWallClock(2026, 10, 20, 8, 0));
  assert.equal(farLater.since.toISOString(), fromJakartaWallClock(2026, 10, 13, 8, 0).toISOString());

  const sameDay = await resolveBriefSince(db, fromJakartaWallClock(2026, 10, 1, 8, 0, 30));
  assert.equal(sameDay.source, "default", "today's own row is not the previous brief");
});

test("blockers: only the latest revision's report obstacles, plan Blocked steps, and risks near the deadline", async () => {
  const { db } = await seedBriefWorld();
  const { blockers } = await buildMorningBriefFacts(db, BRIEF_NOW);

  assert.equal(blockers.reportingDay, "2026-10-02");
  assert.equal(blockers.fromReports.length, 1, "Wisnu's obstacle was in a revision that a correction replaced");
  const [report] = blockers.fromReports;
  assert.equal(report?.member, "Bagas");
  assert.equal(report?.planRef, "aerolift:6.02");
  assert.equal(report?.category, "waiting_component");
  assert.match(report?.obstacle ?? "", /Konektor belum datang/);
  assert.doesNotMatch(report?.obstacle ?? "", /0812/, "phone numbers never reach the facts");

  assert.deepEqual(blockers.planBlocked.map((b) => b.planRef), ["aerolift:6.02"]);
  assert.equal(blockers.planBlocked[0]?.risk, "Konektor belum dikirim supplier");
  assert.deepEqual(blockers.riskDueSoon.map((r) => r.planRef), ["aerolift:3.07"], "6.02 is already listed as Blocked");
});

test("flags: open ones created since the previous brief, with the plan's status, ids resolved either way", async () => {
  const { db } = await seedBriefWorld();
  const { flags } = await buildMorningBriefFacts(db, BRIEF_NOW);

  assert.deepEqual(flags.map((f) => f.kind), ["done_vs_plan", "low_confidence"]);
  assert.deepEqual(flags.map((f) => f.planRef), ["aerolift:1.01", "aerolift:3.07"]);
  assert.equal(flags[0]?.planStatus, "Berjalan");
  assert.equal(flags[0]?.note, "belum ada bukti uji");
  assert.equal(flags[0]?.member, "Bagas");
});

test("quiet tasks: open steps inside their window with no linked report in the last two reporting days", async () => {
  const { db } = await seedBriefWorld();
  const { quiet } = await buildMorningBriefFacts(db, BRIEF_NOW);
  assert.deepEqual(quiet.map((q) => q.planRef), EXPECTED.quietRefs);
});

test("quiet tasks: with no recent reports at all nothing is called quiet", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, fromJakartaWallClock(2026, 10, 20, 8, 0));
  assert.deepEqual(facts.quiet, []);
});

test("general counts leave plan tasks out, and list who is on leave", async () => {
  const { db } = await seedBriefWorld();
  const { general, memberNames } = await buildMorningBriefFacts(db, BRIEF_NOW);

  assert.equal(general.active, 1, "only 'Rapikan gudang' is not a plan task");
  assert.equal(general.overdue, 0);
  assert.deepEqual(general.onLeaveToday, ["Udin"]);
  assert.ok(memberNames.includes("Udin") && memberNames.includes("Bagas"));
  assert.ok(!memberNames.includes("Admin"));
});

test("the facts survive a JSON round trip unchanged", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts);
});

test("resolvePlanRef accepts the id, the bracketed id and the full ref, and nothing the facts do not mention", async () => {
  const { db } = await seedBriefWorld();
  const facts = await buildMorningBriefFacts(db, BRIEF_NOW);
  assert.equal(resolvePlanRef("3.07", facts), "aerolift:3.07");
  assert.equal(resolvePlanRef("[3.07]", facts), "aerolift:3.07");
  assert.equal(resolvePlanRef("aerolift:3.07", facts), "aerolift:3.07");
  assert.equal(resolvePlanRef("9.99", facts), null);
  assert.equal(resolvePlanRef("2.01", facts), null, "a finished step the facts never mention is not citable");
});
