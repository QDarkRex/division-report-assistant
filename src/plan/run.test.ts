import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import type { sheets_v4 } from "googleapis";
import { createTestDb } from "../db/testing.ts";
import { members, planItems, tasks } from "../db/schema.ts";
import { createMember } from "../members/service.ts";
import { registerScheduledJobs } from "../jobs/scheduler.ts";
import { formatPlanSyncSummary, runPlanSync, type PlanSyncConfig } from "./run.ts";
import { fetchPlanGrid, type ReadOnlySheets } from "./sheet-source.ts";
import { PlanSyncAbortError } from "./sync.ts";

const NOW = new Date("2026-10-03T01:00:00.000Z");

type Cell = sheets_v4.Schema$CellData;
const text = (s: string): Cell => ({ formattedValue: s, effectiveValue: { stringValue: s } });
const number = (n: number, formatted: string): Cell => ({ formattedValue: formatted, effectiveValue: { numberValue: n } });

const HEADER = ["ID", "Area Perbaikan", "PIC", "Tahap Pekerjaan", "Mulai", "Deadline", "Status", "Progress"].map(text);
const planRow = (id: number, formattedId: string, step: string, status = "Berjalan"): Cell[] => [
  number(id, formattedId),
  text("Perapihan wiring"),
  text("Wisnu Wisnu"),
  text(step),
  number(46293, "28 Sep 2026"),
  number(46300, "5 Okt 2026"),
  text(status),
  number(0.5, "50%"),
];

/** A fake API that records the calls it is asked to make, returning the shape spreadsheets.get really returns. */
function fakeSheets(rows: Cell[][]): { sheets: ReadOnlySheets; calls: unknown[] } {
  const calls: unknown[] = [];
  const sheets = {
    spreadsheets: {
      get: async (params: unknown) => {
        calls.push(params);
        return { data: { sheets: [{ properties: { title: "Master Plan" }, data: [{ rowData: [{ values: [text("Judul")] }, ...rows.map((values) => ({ values }))] }] }] } };
      },
      values: { get: async () => ({ data: {} }), batchGet: async () => ({ data: {} }) },
    },
  } as unknown as ReadOnlySheets;
  return { sheets, calls };
}

// The header must be reachable below the title row, so the rowData above puts it after "Judul".
const withHeader = (rows: Cell[][]) => [HEADER, ...rows];

function config(sheets: ReadOnlySheets): PlanSyncConfig {
  return { sheets, spreadsheetId: "sheet-1", sheetName: "Master Plan", sourceKey: "aerolift", projectName: "Aerolift Drone Mobil" };
}

async function seed() {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Affan", role: "admin" });
  const wisnu = await createMember(db, { preferredName: "Wisnu" });
  await db.update(members).set({ membershipStatus: "active" });
  return { db, admin, wisnu };
}

test("fetchPlanGrid asks for one grid snapshot of the quoted tab and maps both renderings of each cell", async () => {
  const { sheets, calls } = fakeSheets(withHeader([planRow(5.1, "5.10", "Pengetesan")]));
  const grid = await fetchPlanGrid(sheets, "sheet-1", "Master Plan");

  assert.equal(calls.length, 1);
  const call = calls[0] as { ranges: string[]; includeGridData: boolean };
  assert.equal(call.includeGridData, true);
  assert.match(call.ranges[0] ?? "", /^'Master Plan'!A1:/);
  const idCell = grid[2]?.[0];
  assert.equal(idCell?.formatted, "5.10");
  assert.equal(idCell?.value, 5.1);
});

test("end to end: sheet -> parse -> sync creates the tasks, ID 5.10 intact, and a second run writes nothing", async () => {
  const { db, wisnu } = await seed();
  const { sheets } = fakeSheets(withHeader([planRow(5.09, "5.09", "QC"), planRow(5.1, "5.10", "Pengetesan")]));

  const first = await runPlanSync(db, config(sheets), NOW, { dryRun: false });
  assert.equal(first?.sync.added, 2);
  assert.deepEqual(
    (await db.select().from(planItems)).map((i) => i.planRef).sort(),
    ["aerolift:5.09", "aerolift:5.10"],
  );
  const [ten] = await db.select().from(tasks).where(eq(tasks.sourceReference, "master-plan-aerolift:5.10"));
  assert.equal(ten?.title, "Perapihan wiring: Pengetesan");
  assert.equal(ten?.scheduledFor, "2026-09-28");
  assert.equal(ten?.deadlineLabel, "2026-10-05");
  assert.ok(wisnu.memberId);

  const before = await db.select().from(tasks);
  const second = await runPlanSync(db, config(sheets), new Date(NOW.getTime() + 15 * 60 * 1000), { dryRun: false });
  assert.equal(second?.sync.unchanged, 2);
  assert.deepEqual(await db.select().from(tasks), before);
  assert.match(formatPlanSyncSummary(second!), /^plan-sync rows=2 unchanged=2 updated=0 added=0 /);
});

test("a read that returns no table at all fails loudly and writes nothing", async () => {
  const { db } = await seed();
  const { sheets } = fakeSheets([]);
  await assert.rejects(() => runPlanSync(db, config(sheets), NOW, { dryRun: false }), /header row not found/);
  assert.equal((await db.select().from(tasks)).length, 0);
});

test("a header with no rows under it is the guard's 0-row abort, not a mass removal", async () => {
  const { db } = await seed();
  const first = fakeSheets(withHeader([planRow(1.01, "1.01", "A"), planRow(1.02, "1.02", "B")]));
  await runPlanSync(db, config(first.sheets), NOW, { dryRun: false });

  const empty = fakeSheets(withHeader([]));
  await assert.rejects(() => runPlanSync(db, config(empty.sheets), NOW, { dryRun: false }), PlanSyncAbortError);
  assert.equal((await db.select().from(planItems).where(eq(planItems.planRef, "aerolift:1.01")))[0]?.missingSince, null);
});

// --- scheduler wiring ------------------------------------------------------

function fakeBoss() {
  const queues = new Set<string>();
  const scheduled: { name: string; cron: string; options: unknown }[] = [];
  const handlers = new Map<string, () => Promise<void>>();
  return {
    createQueue: async (name: string) => void queues.add(name),
    schedule: async (name: string, cron: string, _data: unknown, options: unknown) => {
      if (!queues.has(name)) throw new Error(`Queue ${name} not found`);
      scheduled.push({ name, cron, options });
    },
    unschedule: async () => {},
    work: async (name: string, handler: () => Promise<void>) => {
      if (!queues.has(name)) throw new Error(`Queue ${name} not found`);
      handlers.set(name, handler);
    },
    scheduled,
    handlers,
  };
}

test("the plan job is not registered unless a plan is configured", async () => {
  const boss = fakeBoss();
  await registerScheduledJobs({ db: {} as never, boss: boss as never, sendGroupText: async () => {} });
  assert.ok(!boss.scheduled.some((s) => s.name === "wdh.plan-sync"));
  assert.equal(boss.scheduled.length, 9);
});

test("the plan job runs every 15 minutes, 07-22 Jakarta; a failure is swallowed and sends no WhatsApp message", async () => {
  const boss = fakeBoss();
  const sent: string[] = [];
  const failing = {
    spreadsheets: {
      get: async () => {
        throw new Error("403 forbidden");
      },
      values: { get: async () => ({ data: {} }), batchGet: async () => ({ data: {} }) },
    },
  } as unknown as ReadOnlySheets;
  await registerScheduledJobs({
    db: {} as never,
    boss: boss as never,
    sendGroupText: async (t) => void sent.push(t),
    planSync: config(failing),
  });

  const job = boss.scheduled.find((s) => s.name === "wdh.plan-sync");
  assert.equal(job?.cron, "3,18,33,48 7-22 * * *");
  assert.deepEqual(job?.options, { tz: "Asia/Jakarta" });
  assert.equal(boss.scheduled.length, 10);

  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    await boss.handlers.get("wdh.plan-sync")?.();
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1, "the failure is logged");
  assert.deepEqual(sent, [], "and nobody is messaged");
});
