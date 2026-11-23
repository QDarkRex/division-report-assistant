import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, like } from "drizzle-orm";
import { createTestDb, type TestDb } from "../db/testing.ts";
import { members, planItemChanges, planItems, projects, taskAssignees, taskEvents, tasks } from "../db/schema.ts";
import { createMember, addAlias } from "../members/service.ts";
import { confirmProject, createProject } from "../projects/service.ts";
import { adminNoteFor, mustFinishBeforeFor, sourceReferenceFor } from "./mapping.ts";
import type { PlanRow } from "./parse.ts";
import { PlanSyncAbortError, syncPlan, type SyncPlanOptions } from "./sync.ts";

const NOW = new Date("2026-10-03T01:00:00.000Z"); // 08:00 Jakarta
const OPTS: SyncPlanOptions = { sourceKey: "aerolift", projectName: "Aerolift Drone Mobil", now: NOW, dryRun: false };

function planRow(id: string, overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id,
    area: "BMS Drone Kestrel",
    step: `Langkah ${id}`,
    pic: "Bagas Pratama",
    priority: "P2",
    start: "2026-09-28",
    deadline: "2026-10-05",
    statusText: "Berjalan",
    progress: 0.5,
    dependsOn: null,
    output: "Hasil",
    doneWhen: "Lolos tes",
    risk: null,
    support: null,
    note: null,
    ...overrides,
  };
}

async function activeMember(db: TestDb, name: string, role: "member" | "admin" = "member") {
  const member = await createMember(db, { preferredName: name, role });
  await db.update(members).set({ membershipStatus: "active" }).where(eq(members.memberId, member.memberId));
  return member;
}

interface World {
  db: TestDb;
  affan: { memberId: string };
  bagas: { memberId: string };
  gunawan: { memberId: string };
  wisnu: { memberId: string };
}

async function world(): Promise<World> {
  const db = await createTestDb();
  const affan = await activeMember(db, "Affan", "admin");
  const bagas = await activeMember(db, "Bagas Pratama");
  await addAlias(db, bagas.memberId, "Bagas");
  const gunawan = await activeMember(db, "Gunawan");
  const wisnu = await activeMember(db, "Wisnu");
  return { db, affan, bagas, gunawan, wisnu };
}

/** A task exactly as src/scripts/import-aerolift-master-plan-20261001.ts left it, before any plan_items row existed. */
async function importedTask(w: World, row: PlanRow, assigneeId: string) {
  let [project] = await w.db.select().from(projects).where(eq(projects.name, OPTS.projectName)).limit(1);
  if (!project) {
    project = await createProject(w.db, { name: OPTS.projectName, createdByMemberId: w.affan.memberId });
    await confirmProject(w.db, project.projectId);
  }
  const title = `${row.area}: ${row.step}`;
  const [task] = await w.db
    .insert(tasks)
    .values({
      title,
      normalizedTitle: title.toLowerCase(),
      projectId: project.projectId,
      createdByMemberId: w.affan.memberId,
      sourceReference: sourceReferenceFor("aerolift", row.id),
      scheduledFor: row.start,
      deadlineLabel: row.deadline,
      mustFinishBefore: mustFinishBeforeFor(row.deadline ?? "2026-10-05"),
      adminNote: adminNoteFor(row),
      latestUpdate: `Progress ${Math.round((row.progress ?? 0) * 100)}% (Master Plan Rev 01, 24 Sep 2026)`,
      status: row.statusText === "Selesai" ? "done" : row.statusText === "Berjalan" ? "in_progress" : "active",
    })
    .returning();
  await w.db.insert(taskAssignees).values({ taskId: task!.taskId, memberId: assigneeId });
  return task!;
}

const getTask = async (db: TestDb, taskId: string) => (await db.select().from(tasks).where(eq(tasks.taskId, taskId)))[0]!;
const changeRows = (db: TestDb) => db.select().from(planItemChanges);
const eventsFor = (db: TestDb, taskId: string) => db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
const assigneesOf = async (db: TestDb, taskId: string) =>
  (await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, taskId))).map((a) => a.memberId);

async function snapshotOfWrites(db: TestDb) {
  return {
    tasks: await db.select().from(tasks),
    items: await db.select().from(planItems),
    changes: await db.select().from(planItemChanges),
    events: await db.select().from(taskEvents),
    assignees: await db.select().from(taskAssignees),
    projects: await db.select().from(projects),
  };
}

test("baseline: a plan_items row for an already-imported task records no change and rewrites nothing", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);

  const result = await syncPlan(w.db, [row], OPTS);

  assert.equal(result.baselined, 1);
  assert.equal(result.changes.length, 0);
  assert.equal((await changeRows(w.db)).length, 0);
  const [item] = await w.db.select().from(planItems);
  assert.equal(item?.planRef, "aerolift:1.01");
  assert.equal(item?.taskId, task.taskId);
  assert.equal(item?.progressPct, 50);
  assert.equal(item?.statusText, "Berjalan");
  assert.equal((await getTask(w.db, task.taskId)).version, task.version, "an already-consistent task is not touched");
  assert.equal((await eventsFor(w.db, task.taskId)).length, 0);
});

test("baseline still brings a drifted task in line with the plan, silently", async () => {
  const w = await world();
  const row = planRow("1.01", { statusText: "Selesai", progress: 1 });
  const task = await importedTask(w, planRow("1.01"), w.bagas.memberId); // imported while it was Berjalan

  const result = await syncPlan(w.db, [row], OPTS);

  assert.equal(result.baselined, 1);
  assert.equal(result.changes.length, 0, "baseline records no change");
  assert.equal(result.tasksUpdated, 1);
  const after = await getTask(w.db, task.taskId);
  assert.equal(after.status, "done");
  assert.equal(after.version, task.version + 1);
  assert.match(after.latestUpdate ?? "", /^Progress 100% \(plan, 2026-10-03\)$/);
});

test("unchanged: a second run writes nothing — no version bump, no events, no changes", async () => {
  const w = await world();
  const rows = [planRow("1.01"), planRow("1.02", { pic: "Gunawan" })];
  await importedTask(w, rows[0]!, w.bagas.memberId);
  await importedTask(w, rows[1]!, w.gunawan.memberId);
  await syncPlan(w.db, rows, OPTS);

  const before = await snapshotOfWrites(w.db);
  const later = new Date(NOW.getTime() + 15 * 60 * 1000);
  const result = await syncPlan(w.db, rows, { ...OPTS, now: later });

  assert.equal(result.unchanged, 2);
  assert.equal(result.tasksUpdated, 0);
  assert.equal(result.changes.length, 0);
  assert.deepEqual(await snapshotOfWrites(w.db), before, "every table is byte-for-byte what it was");
});

test("unchanged for over an hour: only plan_items.last_seen_at is refreshed, tasks are untouched", async () => {
  const w = await world();
  const row = planRow("1.01");
  await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);
  const before = await snapshotOfWrites(w.db);

  const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
  await syncPlan(w.db, [row], { ...OPTS, now: later });

  const after = await snapshotOfWrites(w.db);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.changes, before.changes);
  assert.equal(after.items[0]?.lastSeenAt.getTime(), later.getTime());
  assert.equal(after.items[0]?.updatedAt.getTime(), before.items[0]?.updatedAt.getTime());
});

test("status change: task follows the plan, a plan_sync event and a change row are written, version bumps", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);
  const versionBefore = (await getTask(w.db, task.taskId)).version;

  const next = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
  const result = await syncPlan(w.db, [planRow("1.01", { statusText: "Selesai", progress: 1 })], { ...OPTS, now: next });

  const after = await getTask(w.db, task.taskId);
  assert.equal(after.status, "done");
  assert.equal(after.version, versionBefore + 1);
  assert.equal(after.updatedAt.getTime(), next.getTime());
  assert.equal(after.latestUpdate, "Progress 100% (plan, 2026-10-04)");

  const [event] = await eventsFor(w.db, task.taskId);
  assert.equal(event?.eventType, "plan_sync");
  assert.equal(event?.fromStatus, "in_progress");
  assert.equal(event?.toStatus, "done");
  assert.equal(event?.actorMemberId, null);

  const fields = result.changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ["progress", "status"]);
  const status = (await changeRows(w.db)).find((c) => c.field === "status");
  assert.equal(status?.planRef, "aerolift:1.01");
  assert.equal(status?.taskId, task.taskId);
  assert.equal(status?.oldValue, "Berjalan");
  assert.equal(status?.newValue, "Selesai");
  assert.equal(status?.detectedAt.getTime(), next.getTime());
});

test("the plan may reopen a finished step: Selesai back to Berjalan is applied from any status", async () => {
  const w = await world();
  const done = planRow("1.01", { statusText: "Selesai", progress: 1 });
  const task = await importedTask(w, done, w.bagas.memberId);
  await syncPlan(w.db, [done], OPTS);

  await syncPlan(w.db, [planRow("1.01", { statusText: "Berjalan", progress: 0.8 })], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  assert.equal((await getTask(w.db, task.taskId)).status, "in_progress");
});

test("each plan status maps to the agreed task status", async () => {
  const w = await world();
  const cases: [string, string][] = [
    ["Selesai", "done"],
    ["Berjalan", "in_progress"],
    ["Belum Mulai", "active"],
    ["Blocked", "blocked"],
    ["Menunggu Input", "paused"],
  ];
  const rows = cases.map(([statusText], i) => planRow(`9.0${i + 1}`, { statusText }));
  await syncPlan(w.db, rows, OPTS);
  for (const [i, [, expected]] of cases.entries()) {
    const [task] = await w.db.select().from(tasks).where(eq(tasks.sourceReference, sourceReferenceFor("aerolift", `9.0${i + 1}`)));
    assert.equal(task?.status, expected);
  }
});

test("an unknown plan status leaves the task's status alone but is still remembered", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);

  await syncPlan(w.db, [planRow("1.01", { statusText: "Ditunda sebentar" })], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  assert.equal((await getTask(w.db, task.taskId)).status, "in_progress");
  const [item] = await w.db.select().from(planItems);
  assert.equal(item?.statusText, "Ditunda sebentar");
  assert.ok((await changeRows(w.db)).some((c) => c.field === "status" && c.newValue === "Ditunda sebentar"));
});

test("PIC change: the assignee is replaced to match the plan and a pic change is recorded", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);

  await syncPlan(w.db, [planRow("1.01", { pic: "Gunawan" })], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  assert.deepEqual(await assigneesOf(w.db, task.taskId), [w.gunawan.memberId]);
  const pic = (await changeRows(w.db)).find((c) => c.field === "pic");
  assert.equal(pic?.oldValue, "Bagas Pratama");
  assert.equal(pic?.newValue, "Gunawan");
});

test("PIC resolves by full name, then by first token; 'Wisnu Wisnu' finds Wisnu", async () => {
  const w = await world();
  const [a, b] = [planRow("5.01", { pic: "Wisnu Wisnu" }), planRow("1.02", { pic: "Bagas Pratama" })];
  await syncPlan(w.db, [a, b], OPTS);
  const taskOf = async (id: string) =>
    (await w.db.select().from(tasks).where(eq(tasks.sourceReference, sourceReferenceFor("aerolift", id))))[0]!;
  assert.deepEqual(await assigneesOf(w.db, (await taskOf("5.01")).taskId), [w.wisnu.memberId]);
  assert.deepEqual(await assigneesOf(w.db, (await taskOf("1.02")).taskId), [w.bagas.memberId]);
});

test("unresolved PIC: assignees are left alone and pic_unresolved is recorded exactly once", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);

  const unknown = planRow("1.01", { pic: "Orang Asing" });
  const first = await syncPlan(w.db, [unknown], { ...OPTS, now: new Date(NOW.getTime() + 1000) });
  const second = await syncPlan(w.db, [unknown], { ...OPTS, now: new Date(NOW.getTime() + 2000) });

  assert.deepEqual(await assigneesOf(w.db, task.taskId), [w.bagas.memberId], "no guess, no change");
  assert.equal(first.picUnresolved, 1);
  assert.equal(second.picUnresolved, 0);
  const rows = (await changeRows(w.db)).filter((c) => c.field === "pic_unresolved");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.newValue, "Orang Asing");
});

test("a PIC matching several active members is unresolved; a resigned namesake does not make it ambiguous", async () => {
  const w = await world();
  const budi1 = await activeMember(w.db, "Budi Santoso");
  await activeMember(w.db, "Budi Hartono");
  const resigned = await createMember(w.db, { preferredName: "Citra Dewi" });
  await w.db.update(members).set({ membershipStatus: "resigned" }).where(eq(members.memberId, resigned.memberId));
  const citra = await activeMember(w.db, "Citra Lestari");
  await addAlias(w.db, citra.memberId, "Citra Dewi");

  const result = await syncPlan(w.db, [planRow("7.01", { pic: "Budi" }), planRow("7.02", { pic: "Citra Dewi" })], OPTS);

  const t = async (id: string) => (await w.db.select().from(tasks).where(eq(tasks.sourceReference, sourceReferenceFor("aerolift", id))))[0]!;
  assert.deepEqual(await assigneesOf(w.db, (await t("7.01")).taskId), [], "two Budis: new task stays unassigned");
  assert.deepEqual(await assigneesOf(w.db, (await t("7.02")).taskId), [citra.memberId]);
  assert.equal(result.picUnresolved, 1);
  assert.notEqual(budi1.memberId, citra.memberId);
});

test("an added plan row creates a task in the project, with the plan's fields, and records 'added'", async () => {
  const w = await world();
  const existing = planRow("1.01");
  await importedTask(w, existing, w.bagas.memberId);
  await syncPlan(w.db, [existing], OPTS);

  const fresh = planRow("1.02", { pic: "Gunawan", statusText: "Belum Mulai", progress: 0, deadline: "2026-10-09" });
  const result = await syncPlan(w.db, [existing, fresh], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  assert.equal(result.added, 1);
  const [task] = await w.db.select().from(tasks).where(eq(tasks.sourceReference, "master-plan-aerolift:1.02"));
  assert.ok(task);
  assert.equal(task.title, "BMS Drone Kestrel: Langkah 1.02");
  assert.equal(task.status, "active");
  assert.equal(task.deadlineLabel, "2026-10-09");
  assert.equal(task.mustFinishBefore?.toISOString(), "2026-10-09T17:00:00.000Z", "the day AFTER the plan deadline, Jakarta midnight");
  assert.equal(task.scheduledFor, "2026-09-28");
  assert.equal(task.createdByMemberId, w.affan.memberId);
  assert.equal(task.adminNote, adminNoteFor(fresh));
  assert.equal(task.latestUpdate, "Progress 0% (plan, 2026-10-03)");
  assert.deepEqual(await assigneesOf(w.db, task.taskId), [w.gunawan.memberId]);
  const [project] = await w.db.select().from(projects).where(eq(projects.name, "Aerolift Drone Mobil"));
  assert.equal(task.projectId, project?.projectId);
  const events = await eventsFor(w.db, task.taskId);
  assert.equal(events[0]?.eventType, "plan_sync");
  const added = (await changeRows(w.db)).filter((c) => c.field === "added");
  assert.equal(added.length, 1);
  assert.equal(added[0]?.planRef, "aerolift:1.02");
  assert.equal(added[0]?.newValue, "BMS Drone Kestrel: Langkah 1.02");
});

test("a brand-new plan creates the project when it is missing", async () => {
  const w = await world();
  assert.equal((await w.db.select().from(projects)).length, 0);
  await syncPlan(w.db, [planRow("1.01")], OPTS);
  const [project] = await w.db.select().from(projects);
  assert.equal(project?.name, "Aerolift Drone Mobil");
  assert.equal(project?.confirmed, true);
});

test("removed: a vanished step is marked missing, its task cancelled with an event, recorded once; it can reappear", async () => {
  const w = await world();
  const rows = ["1.01", "1.02", "1.03", "1.04"].map((id) => planRow(id));
  const tasksBefore = [];
  for (const r of rows) tasksBefore.push(await importedTask(w, r, w.bagas.memberId));
  await syncPlan(w.db, rows, OPTS);

  const t1 = new Date(NOW.getTime() + 60 * 60 * 1000);
  const first = await syncPlan(w.db, rows.slice(0, 3), { ...OPTS, now: t1 });
  assert.equal(first.removed, 1);
  const [gone] = await w.db.select().from(planItems).where(eq(planItems.taskId, tasksBefore[3]!.taskId));
  assert.equal(gone?.missingSince?.getTime(), t1.getTime());
  assert.equal(gone?.planRef, "aerolift:1.04", "keeps its last ref for history");
  const cancelled = await getTask(w.db, tasksBefore[3]!.taskId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.version, tasksBefore[3]!.version + 1);
  assert.equal(cancelled.sourceReference, `master-plan-aerolift:1.04~removed-${cancelled.taskId.slice(0, 8)}`, "no longer collides with a live 1.04");
  const removedEvent = (await eventsFor(w.db, cancelled.taskId)).find((e) => e.eventType === "plan_removed");
  assert.equal(removedEvent?.fromStatus, "in_progress");
  assert.equal(removedEvent?.toStatus, "cancelled");

  const second = await syncPlan(w.db, rows.slice(0, 3), { ...OPTS, now: new Date(t1.getTime() + 60_000) });
  assert.equal(second.removed, 0, "recorded once");
  assert.equal((await changeRows(w.db)).filter((c) => c.field === "removed").length, 1);

  const t3 = new Date(t1.getTime() + 2 * 60 * 60 * 1000);
  const third = await syncPlan(w.db, rows, { ...OPTS, now: t3 });
  assert.equal(third.reappeared, 1);
  assert.equal(third.added, 0, "the same step coming back is not a new task");
  const [back] = await w.db.select().from(planItems).where(eq(planItems.taskId, tasksBefore[3]!.taskId));
  assert.equal(back?.missingSince, null);
  const restored = await getTask(w.db, tasksBefore[3]!.taskId);
  assert.equal(restored.status, "in_progress", "status comes from the plan again");
  assert.equal(restored.sourceReference, "master-plan-aerolift:1.04");
  const kinds = (await changeRows(w.db)).filter((c) => c.planRef === "aerolift:1.04").map((c) => c.field);
  assert.deepEqual(kinds.sort(), ["reappeared", "removed"]);
});

test("guard: an empty sheet aborts and writes nothing", async () => {
  const w = await world();
  const row = planRow("1.01");
  await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);
  const before = await snapshotOfWrites(w.db);

  await assert.rejects(() => syncPlan(w.db, [], { ...OPTS, now: new Date(NOW.getTime() + 1000) }), PlanSyncAbortError);
  assert.deepEqual(await snapshotOfWrites(w.db), before);
});

test("guard: fewer than half of the known rows aborts and writes nothing; exactly half is accepted only when mass removal is allowed", async () => {
  const w = await world();
  const rows = ["1.01", "1.02", "1.03", "1.04"].map((id) => planRow(id));
  for (const r of rows) await importedTask(w, r, w.bagas.memberId);
  await syncPlan(w.db, rows, OPTS);
  const before = await snapshotOfWrites(w.db);

  await assert.rejects(() => syncPlan(w.db, [rows[0]!], { ...OPTS, now: new Date(NOW.getTime() + 1000) }), /under 50%/);
  assert.deepEqual(await snapshotOfWrites(w.db), before, "nothing marked missing");

  // Half is over the removal limit (30%) too: refused unless the operator says it is deliberate.
  await assert.rejects(() => syncPlan(w.db, [rows[0]!, rows[1]!], { ...OPTS, now: new Date(NOW.getTime() + 1500) }), /would remove 2 of 4/);
  assert.deepEqual(await snapshotOfWrites(w.db), before);

  const ok = await syncPlan(w.db, [rows[0]!, rows[1]!], { ...OPTS, now: new Date(NOW.getTime() + 2000), allowMassRemoval: true });
  assert.equal(ok.removed, 2);
});

test("guard: removing more than 30% of the known steps in one run aborts and writes nothing; 30% exactly is accepted", async () => {
  const w = await world();
  const rows = Array.from({ length: 10 }, (_, i) => planRow(`2.${String(i + 1).padStart(2, "0")}`));
  await syncPlan(w.db, rows, OPTS);
  const before = await snapshotOfWrites(w.db);

  await assert.rejects(() => syncPlan(w.db, rows.slice(0, 6), { ...OPTS, now: new Date(NOW.getTime() + 1000) }), PlanSyncAbortError);
  assert.deepEqual(await snapshotOfWrites(w.db), before);

  const ok = await syncPlan(w.db, rows.slice(0, 7), { ...OPTS, now: new Date(NOW.getTime() + 2000) });
  assert.equal(ok.removed, 3);
});

test("guard counts only rows not already missing", async () => {
  const w = await world();
  const rows = ["1.01", "1.02", "1.03", "1.04"].map((id) => planRow(id));
  await syncPlan(w.db, rows, OPTS);
  await syncPlan(w.db, rows.slice(0, 2), { ...OPTS, now: new Date(NOW.getTime() + 1000), allowMassRemoval: true }); // 1.03, 1.04 now missing
  // known (non-missing) is 2, so a single row is exactly half and is accepted.
  const result = await syncPlan(w.db, rows.slice(0, 1), { ...OPTS, now: new Date(NOW.getTime() + 2000), allowMassRemoval: true });
  assert.equal(result.removed, 1);
});

test("dry run returns the changes and persists nothing, even for added and removed rows", async () => {
  const w = await world();
  const rows = [planRow("1.01"), planRow("1.02")];
  for (const r of rows) await importedTask(w, r, w.bagas.memberId);
  await syncPlan(w.db, rows, OPTS);
  const before = await snapshotOfWrites(w.db);

  const result = await syncPlan(
    w.db,
    [planRow("1.01", { statusText: "Selesai", progress: 1, pic: "Gunawan" }), planRow("1.03")],
    { ...OPTS, dryRun: true, now: new Date(NOW.getTime() + 1000), allowMassRemoval: true },
  );

  assert.equal(result.dryRun, true);
  const fields = result.changes.map((c) => c.field);
  for (const f of ["status", "progress", "pic", "added", "removed"]) assert.ok(fields.includes(f as never), `dry run reports ${f}`);
  assert.deepEqual(await snapshotOfWrites(w.db), before);
});

test("a dry run on a database with no plan yet does not create the project or tasks", async () => {
  const w = await world();
  const result = await syncPlan(w.db, [planRow("1.01")], { ...OPTS, dryRun: true });
  assert.equal(result.added, 1);
  assert.equal((await w.db.select().from(projects)).length, 0);
  assert.equal((await w.db.select().from(tasks)).length, 0);
});

test("deadline and start changes are recorded and applied; the inclusive deadline becomes the next day's midnight", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);

  await syncPlan(w.db, [planRow("1.01", { start: "2026-09-30", deadline: "2026-10-12" })], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  const after = await getTask(w.db, task.taskId);
  assert.equal(after.deadlineLabel, "2026-10-12");
  assert.equal(after.mustFinishBefore?.toISOString(), "2026-10-12T17:00:00.000Z");
  assert.equal(after.scheduledFor, "2026-09-30");
  const changes = await changeRows(w.db);
  const deadline = changes.find((c) => c.field === "deadline");
  assert.equal(deadline?.oldValue, "2026-10-05");
  assert.equal(deadline?.newValue, "2026-10-12");
  assert.ok(changes.some((c) => c.field === "start" && c.oldValue === "2026-09-28" && c.newValue === "2026-09-30"));
});

test("a date the plan blanks out is recorded as a change but does not wipe the task's deadline", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);

  await syncPlan(w.db, [planRow("1.01", { deadline: null })], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  const after = await getTask(w.db, task.taskId);
  assert.equal(after.deadlineLabel, "2026-10-05");
  assert.ok(after.mustFinishBefore);
  assert.ok((await changeRows(w.db)).some((c) => c.field === "deadline" && c.newValue === null));
});

test("title change (area or step renamed) updates the task title and normalized title", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);

  await syncPlan(w.db, [planRow("1.01", { step: "Langkah Baru" })], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  const after = await getTask(w.db, task.taskId);
  assert.equal(after.title, "BMS Drone Kestrel: Langkah Baru");
  assert.equal(after.normalizedTitle, "bms drone kestrel: langkah baru");
  const title = (await changeRows(w.db)).find((c) => c.field === "title");
  assert.equal(title?.oldValue, "BMS Drone Kestrel: Langkah 1.01");
  assert.equal(title?.newValue, "BMS Drone Kestrel: Langkah Baru");
});

test("a note-only change updates the task's admin note without recording a plan change", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);

  const result = await syncPlan(w.db, [planRow("1.01", { risk: "Part terlambat" })], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  assert.match((await getTask(w.db, task.taskId)).adminNote ?? "", /Risiko: Part terlambat/);
  assert.equal(result.changes.length, 0);
  assert.equal(result.tasksUpdated, 1);
});

test("latest_update is not clobbered: a report's text survives while the plan's progress is unchanged", async () => {
  const w = await world();
  const row = planRow("1.01");
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);
  await w.db.update(tasks).set({ latestUpdate: "Bagas: soldering selesai 3 dari 4" }).where(eq(tasks.taskId, task.taskId));
  const before = await getTask(w.db, task.taskId);

  await syncPlan(w.db, [row], { ...OPTS, now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) });

  const after = await getTask(w.db, task.taskId);
  assert.equal(after.latestUpdate, "Bagas: soldering selesai 3 dari 4");
  assert.equal(after.version, before.version);

  await syncPlan(w.db, [planRow("1.01", { progress: 0.75 })], { ...OPTS, now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000) });
  assert.equal((await getTask(w.db, task.taskId)).latestUpdate, "Progress 75% (plan, 2026-10-04)");
});

test("a member's report cannot hold a plan task's status: the next sync puts it back to the plan's", async () => {
  const w = await world();
  const row = planRow("1.01", { statusText: "Belum Mulai", progress: 0 });
  const task = await importedTask(w, row, w.bagas.memberId);
  await syncPlan(w.db, [row], OPTS);
  await w.db.update(tasks).set({ status: "done" }).where(eq(tasks.taskId, task.taskId));

  await syncPlan(w.db, [row], { ...OPTS, now: new Date(NOW.getTime() + 1000) });

  assert.equal((await getTask(w.db, task.taskId)).status, "active");
  const [event] = await eventsFor(w.db, task.taskId);
  assert.equal(event?.fromStatus, "done");
  assert.equal(event?.toStatus, "active");
  assert.equal((await changeRows(w.db)).length, 0, "not a plan change, so not recorded as one");
});

test("tasks of other sources and ordinary tasks are never touched", async () => {
  const w = await world();
  const [ordinary] = await w.db
    .insert(tasks)
    .values({ title: "Cek panel", normalizedTitle: "cek panel", createdByMemberId: w.affan.memberId, sourceReference: "master-plan-lain:1.01" })
    .returning();
  await syncPlan(w.db, [planRow("1.01")], OPTS);
  assert.equal((await getTask(w.db, ordinary!.taskId)).version, 1);
  assert.equal((await w.db.select().from(planItems).where(like(planItems.planRef, "lain:%"))).length, 0);
  assert.equal((await w.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, ordinary!.taskId)))).length, 0);
});
