import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { dailyReports, members, reportItemFlags, reportItems, reportRevisions, tasks } from "../db/schema.ts";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import { loadPlanContext, raiseNoUrgentWorkFlag, raisePlanFlags } from "../plan/matching.ts";
import type { PlanRow } from "../plan/parse.ts";
import { syncPlan, type SyncPlanOptions } from "../plan/sync.ts";
import { fromJakartaWallClock } from "../shared/time.ts";
import { buildMorningBriefFacts } from "./facts.ts";
import { renderMorningBrief } from "./render.ts";

const AREA = "Perapihan wiring ulang box Master Controller";
const T0 = new Date("2026-10-01T01:00:00.000Z");
const NOW = fromJakartaWallClock(2026, 10, 3, 8, 0);
const OPTS: SyncPlanOptions = { sourceKey: "aerolift", projectName: "Aerolift Drone Mobil", now: T0, dryRun: false };

const row = (id: string, step: string, over: Partial<PlanRow> = {}): PlanRow => ({
  id,
  area: AREA,
  step,
  pic: "Wisnu",
  priority: "P2",
  start: "2026-10-01",
  deadline: "2026-10-30",
  statusText: "Belum Mulai",
  progress: 0,
  dependsOn: null,
  output: null,
  doneWhen: null,
  risk: null,
  support: null,
  note: null,
  ...over,
});

const fillers = (): PlanRow[] =>
  Array.from({ length: 8 }, (_, i) => row(`1.0${i + 1}`, `Pekerjaan nomor ${i + 1} khusus`, { area: "Area 1", pic: "Wisnu" }));

const OLD = [
  row("5.03", "QC dan pemasangan box kontroler baru (mobil aerolift drone 2)"),
  row("5.04", "Pengetesan mobil aerolift drone 2"),
  row("5.05", "Wiring box daya mobil aerolift drone 2"),
  row("5.06", "Pembongkaran box kontroler lama"),
];
const NEW = [
  row("5.03", "Wiring box PSU mobil aerolift drone 2"),
  row("5.04", "QC dan pemasangan kedua box yang baru di mobil aerolift drone 2"),
  row("5.05", "Pengetesan mobil aerolift drone 2"),
  row("5.06", "Kalibrasi sensor ketinggian"),
];

async function setup() {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Affan", role: "admin" });
  const wisnu = await createMember(db, { preferredName: "Wisnu", role: "member" });
  for (const m of [admin, wisnu]) await db.update(members).set({ membershipStatus: "active" }).where(eq(members.memberId, m.memberId));
  await syncPlan(db, [...fillers(), ...OLD], OPTS);
  const reshuffled = await syncPlan(db, [...fillers(), ...NEW], { ...OPTS, now: new Date(NOW.getTime() - 3_600_000) });
  assert.equal(reshuffled.renumbered, 3);
  return { db, admin, wisnu };
}

test("the brief's 'Perubahan plan' renders renumbered, added and removed steps by name, and the removed step is out of the plan", async () => {
  const { db } = await setup();
  const facts = await buildMorningBriefFacts(db, NOW, { since: new Date(NOW.getTime() - 24 * 3_600_000) });

  const text = renderMorningBrief(facts, null);
  // The step text is clipped to 60 characters in the brief.
  assert.match(text, /• \[5\.05\] → \[5\.03\] Wiring box PSU mobil aerolift drone 2$/m);
  assert.match(text, /• \[5\.03\] → \[5\.04\] QC dan pemasangan kedua box yang baru di mobil aerolift dro…$/m);
  assert.doesNotMatch(text, /judul diubah/);
  assert.match(text, /\[5\.04\] → \[5\.05\] Pengetesan mobil aerolift drone 2/);
  assert.match(text, /\[5\.06\] Kalibrasi sensor ketinggian — langkah baru ditambahkan/);
  assert.match(text, /\[5\.06\] Pembongkaran box kontroler lama — dihapus dari plan/);
  // 5.06 is a reused ID: the removed "Pembongkaran" and the added "Kalibrasi" are two separate lines.
  assert.equal(facts.planChanges.filter((g) => g.id === "5.06").length, 2);

  // Counts and lists are about the live plan only: 8 fillers + 4 steps, the removed 'Pembongkaran' is neither counted nor listed.
  assert.equal(facts.plan?.itemCount, 12);
  assert.ok(!Object.values(facts.plan!.labels).some((l) => l.includes("Pembongkaran")));
  assert.ok(!facts.plan!.dueTomorrow.concat(facts.plan!.dueToday, facts.plan!.overdue, facts.plan!.startingToday).some((i) => i.title.includes("Pembongkaran")));
});

test("flags store the full plan_ref and the brief shows [5.04] for the full form and for the bare id alike; no_urgent_work lists the in-window ids", async () => {
  const { db, wisnu } = await setup();
  const [qc] = await db.select().from(tasks).where(eq(tasks.sourceReference, "master-plan-aerolift:5.04"));
  assert.ok(qc);

  const [report] = await db.insert(dailyReports).values({ memberId: wisnu.memberId, reportingDay: "2026-10-02" }).returning();
  const [revision] = await db.insert(reportRevisions).values({ reportId: report!.reportId, revisionNumber: 1, rawText: "QC selesai" }).returning();
  const [item] = await db
    .insert(reportItems)
    .values({ revisionId: revision!.revisionId, taskId: qc.taskId, activity: "QC box selesai", status: "done" })
    .returning();

  const ctx = await loadPlanContext(db, qc);
  assert.equal(ctx?.planRef, "aerolift:5.04");
  await raisePlanFlags(db, ctx!, {
    itemId: item!.itemId,
    revisionId: revision!.revisionId,
    reportId: report!.reportId,
    memberId: wisnu.memberId,
    memberName: "Wisnu",
    reportingDay: "2026-10-02",
    activity: "QC box selesai",
    status: "done",
    obstacle: null,
  });
  await raiseNoUrgentWorkFlag(db, {
    firstItem: {
      itemId: item!.itemId,
      revisionId: revision!.revisionId,
      reportId: report!.reportId,
      memberId: wisnu.memberId,
      memberName: "Wisnu",
      reportingDay: "2026-10-02",
      activity: "QC box selesai",
    },
  });

  const flags = await db.select().from(reportItemFlags);
  const done = flags.find((f) => f.kind === "done_vs_plan");
  assert.equal((done?.detail as { planRef: string }).planRef, "aerolift:5.04", "the full ref is what gets stored");
  const urgent = flags.find((f) => f.kind === "no_urgent_work");
  const urgentDetail = urgent?.detail as { planRefs: string[]; planIds: string[] };
  assert.ok(urgentDetail.planRefs.every((r) => r.startsWith("aerolift:")));
  assert.ok(urgentDetail.planIds.includes("5.04") && urgentDetail.planIds.includes("1.01"));

  // A flag written the old way (bare id) renders the same.
  await db.insert(reportItemFlags).values({
    itemId: item!.itemId,
    reportId: report!.reportId,
    memberId: wisnu.memberId,
    taskId: null,
    kind: "low_confidence",
    detail: { planRef: "5.04", activity: "x", note: "n" },
  });
  await db.update(reportItemFlags).set({ createdAt: new Date(NOW.getTime() - 3_600_000) });

  const facts = await buildMorningBriefFacts(db, NOW, { since: new Date(NOW.getTime() - 24 * 3_600_000) });
  const text = renderMorningBrief(facts, null);
  assert.match(text, /Wisnu lapor selesai \[5\.04\], plan masih Belum Mulai/);
  assert.match(text, /Laporan Wisnu "x" — mungkin \[5\.04\], menunggu jawaban/);
  assert.match(text, /Wisnu belum melaporkan task urgent-nya \(\[1\.01\] /);
  assert.doesNotMatch(text, /aerolift:/);
});
