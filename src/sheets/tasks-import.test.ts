import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import { createProject, confirmProject } from "../projects/service.ts";
import { createTask, getTask } from "../tasks/service.ts";
import { sheetsSyncEvents, taskAssignees, taskEvents, tasks } from "../db/schema.ts";
import { diffAndApplyTasksImport, readTasksSheet, type ParsedTaskRow } from "./tasks-import.ts";
import { buildTasksRows, saveTasksSnapshot } from "./tasks-export.ts";
import { transitionStatus } from "../tasks/service.ts";

const NOW = new Date("2026-08-08T05:00:00.000Z");

function row(overrides: Partial<ParsedTaskRow> & { taskId: string; sheetVersion: number }): ParsedTaskRow {
  return { title: "", projectText: "", status: "", deadlineText: "", scheduledText: "", assigneeNames: [], adminNote: "", ...overrides };
}

test("an unknown task_id is rejected and doesn't touch any real task", async () => {
  const db = await createTestDb();
  const summary = await diffAndApplyTasksImport(db, [row({ taskId: "00000000-0000-0000-0000-000000000000", sheetVersion: 1 })], undefined, NOW);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.applied, 0);
});

test("an all-blank row (no changes) is counted as unchanged, no event written", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  const summary = await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version })], undefined, NOW);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.applied, 0);
  const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.taskId));
  assert.equal(events.length, 0);
});

test("a title edit applies, bumps version, and recomputes normalizedTitle", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  const summary = await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, title: "Cek Panel B Utama" })], undefined, NOW);
  assert.equal(summary.applied, 1);
  const updated = await getTask(db, task.taskId);
  assert.equal(updated?.title, "Cek Panel B Utama");
  assert.equal(updated?.normalizedTitle, "cek panel b utama");
  assert.equal(updated?.version, task.version + 1);
});

test("an admin-note edit applies even when nothing else changes, including clearing it to blank", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, adminNote: "tunggu part" })], undefined, NOW);
  const withNote = await getTask(db, task.taskId);
  assert.equal(withNote?.adminNote, "tunggu part");

  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: withNote?.version ?? 0, adminNote: "" })], undefined, NOW);
  const cleared = await getTask(db, task.taskId);
  assert.equal(cleared?.adminNote, null);
});

test("an invalid status value is rejected as a field but doesn't block other valid fields in the same row", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  const summary = await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: task.version, status: "not_a_real_status", adminNote: "catatan valid" })],
    undefined,
    NOW,
  );
  assert.equal(summary.applied, 1);
  assert.equal(summary.rejected, 0, "the row itself isn't rejected, only the bad field, tracked via a rejected sheetsSyncEvents row");
  const updated = await getTask(db, task.taskId);
  assert.equal(updated?.status, "active", "invalid status must not be applied");
  assert.equal(updated?.adminNote, "catatan valid", "the valid field in the same row still applies");
});

test("deadline must be strict YYYY-MM-DD — a non-matching value is rejected, not best-effort parsed", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, deadlineText: "10 Agustus 2026" })], undefined, NOW);
  const updated = await getTask(db, task.taskId);
  assert.equal(updated?.deadlineLabel, null, "an unparseable deadline text must not be applied at all");
});

test("a valid strict-ISO deadline applies and computes mustFinishBefore", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, deadlineText: "2026-08-10" })], undefined, NOW);
  const updated = await getTask(db, task.taskId);
  assert.equal(updated?.deadlineLabel, "2026-08-10");
  assert.ok(updated?.mustFinishBefore);
});

test("project text resolving to zero or multiple matches is rejected, never guesses", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  const summary = await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, projectText: "Proyek Tidak Ada" })], undefined, NOW);
  assert.equal(summary.unchanged, 1, "project field alone with no valid match, and nothing else changed, leaves the row unchanged");
  const updated = await getTask(db, task.taskId);
  assert.equal(updated?.projectId, null);
});

test("a resolved project applies", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const project = await createProject(db, { name: "Drone VEGA" });
  await confirmProject(db, project.projectId);
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, projectText: "Drone VEGA" })], undefined, NOW);
  const updated = await getTask(db, task.taskId);
  assert.equal(updated?.projectId, project.projectId);
});

test("assignees: a resolvable list replaces the current assignee set", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const budi = await createMember(db, { preferredName: "Budi" });
  const siti = await createMember(db, { preferredName: "Siti" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, assigneeNames: ["Budi", "Siti"] })], undefined, NOW);
  const assignees = await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, task.taskId));
  assert.deepEqual(new Set(assignees.map((a) => a.memberId)), new Set([budi.memberId, siti.memberId]));
});

test("assignees: an unresolvable name rejects the whole assignee field without touching current assignees", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const budi = await createMember(db, { preferredName: "Budi" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });
  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, assigneeNames: ["Budi"] })], undefined, NOW);

  const afterFirst = await getTask(db, task.taskId);
  await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: afterFirst?.version ?? 0, assigneeNames: ["Nama Tidak Ada"] })],
    undefined,
    NOW,
  );
  const assignees = await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, task.taskId));
  assert.deepEqual(assignees.map((a) => a.memberId), [budi.memberId]);
});

test("a stale sheetVersion is a conflict — the edit is not applied, and current DB data is untouched", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  // Simulate the DB having moved on since the sheet snapshot was read (e.g. a live report changed it).
  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, adminNote: "edit pertama" })], undefined, NOW);

  // Now import a second, stale edit still carrying the OLD version.
  const summary = await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: task.version, adminNote: "edit basi" })],
    undefined,
    NOW,
  );
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.applied, 0);
  const current = await getTask(db, task.taskId);
  assert.equal(current?.adminNote, "edit pertama", "the earlier successfully-applied edit must survive a later conflicting one");
});

// ---------------------------------------------------------------------
// Snapshot rule (2026-09-01). Before it, the import diffed the sheet
// against current DB truth, so a task the BOT had moved looked exactly
// like a human edit that had lost a race. That produced 259 logged
// conflicts and 8 WhatsApp notices telling the division their edits were
// rejected — none of those edits existed.
// ---------------------------------------------------------------------

test("a row the bot moved on from, untouched by anyone, is stale — not a conflict", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Wiring docking Alpha", createdByMemberId: admin.memberId });
  await saveTasksSnapshot(db, await buildTasksRows(db));

  // Exactly what a member reporting work does: status moves, version bumps,
  // and the sheet still holds the pre-change row.
  await transitionStatus(db, task.taskId, "member_reports_work", admin.memberId);

  const summary = await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: task.version, title: "Wiring docking Alpha", status: "active" })],
    undefined,
    NOW,
  );

  assert.equal(summary.conflicts, 0, "nobody edited this row");
  assert.equal(summary.stale, 1);
  assert.equal(summary.applied, 0);
  const current = await getTask(db, task.taskId);
  assert.equal(current?.status, "in_progress", "the sheet must not drag the task back to its old status");
});

test("a real edit on a row the bot also moved is still a conflict", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Wiring docking Alpha", createdByMemberId: admin.memberId });
  await saveTasksSnapshot(db, await buildTasksRows(db));
  await transitionStatus(db, task.taskId, "member_reports_work", admin.memberId);

  // adminNote differs from the snapshot, so somebody typed it — and the
  // version they typed it against is gone. That is the case the notice
  // exists for.
  const summary = await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: task.version, title: "Wiring docking Alpha", status: "active", adminNote: "tolong dikebut" })],
    undefined,
    NOW,
  );

  assert.equal(summary.conflicts, 1);
  assert.equal(summary.stale, 0);
});

test("only the field a human actually changed is applied — stale neighbours are left alone", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Wiring docking Alpha", createdByMemberId: admin.memberId });
  await saveTasksSnapshot(db, await buildTasksRows(db));
  await transitionStatus(db, task.taskId, "member_reports_work", admin.memberId);
  const moved = await getTask(db, task.taskId);

  // The sheet still shows status "active" (stale) while the admin edits
  // only the note. Applying the stale status too would silently undo the
  // member report that moved it.
  const summary = await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: moved!.version, title: "Wiring docking Alpha", status: "active", adminNote: "tolong dikebut" })],
    undefined,
    NOW,
  );

  assert.equal(summary.applied, 1);
  const current = await getTask(db, task.taskId);
  assert.equal(current?.adminNote, "tolong dikebut");
  assert.equal(current?.status, "in_progress", "the stale status cell must not be written back");
});

test("with no snapshot for a task, a difference is still treated as an edit", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  const summary = await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: task.version, title: "Cek panel B Utama" })],
    undefined,
    NOW,
  );

  assert.equal(summary.applied, 1, "pre-snapshot behaviour is the fallback, not a silent skip");
});

test("a successful apply writes an admin_sheet_edit task event with the changed field names", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });

  await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, status: "in_progress" })], admin.memberId, NOW);
  const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.taskId));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventType, "admin_sheet_edit");
  assert.equal(events[0]?.actorMemberId, admin.memberId);
  assert.deepEqual(events[0]?.detail, { changedFields: ["status"] });
});

// ---------------------------------------------------------------------
// 2026-09-08: a "Dikerjakan" column was inserted before "Penanggung
// Jawab". Because the sync imports before it exports, the first run after
// that deploy would have read the OLD sheet with the NEW offsets —
// assignees parsed as a schedule, the admin note parsed as assignees, and
// the "Aktif" column ("Ya") written into every task's admin note. Columns
// are located by header text now, so layout changes cannot do this again.
// ---------------------------------------------------------------------

function fakeSheetsReturning(values: string[][]) {
  return { spreadsheets: { values: { get: async () => ({ data: { values } }) } } } as never;
}

test("columns are found by header name, whatever order they are in", async () => {
  const sheets = fakeSheetsReturning([
    ["Catatan Admin", "Penanggung Jawab", "task_id", "version", "Judul", "Proyek", "Status", "Deadline", "Dikerjakan"],
    ["catatan", "Agas, Budi", "11111111-1111-1111-1111-111111111111", "3", "Cek panel", "Strobo", "active", "2026-09-25", "2026-09-09"],
  ]);

  const [row] = await readTasksSheet(sheets, "sheet-1", "TASKS");
  assert.equal(row?.taskId, "11111111-1111-1111-1111-111111111111");
  assert.equal(row?.sheetVersion, 3);
  assert.equal(row?.title, "Cek panel");
  assert.equal(row?.deadlineText, "2026-09-25");
  assert.equal(row?.scheduledText, "2026-09-09");
  assert.deepEqual(row?.assigneeNames, ["Agas", "Budi"]);
  assert.equal(row?.adminNote, "catatan");
});

// The exact layout the incident would have hit: no "Dikerjakan" column at
// all. Every other field must still land in the right place — which is the
// whole point of locating by name — and the missing one reads as empty
// rather than shifting everything one position left.
test("a sheet still on the old layout is read correctly, not shifted", async () => {
  const sheets = fakeSheetsReturning([
    ["task_id", "version", "Judul", "Proyek", "Status", "Deadline", "Penanggung Jawab", "Catatan Admin", "Aktif"],
    ["11111111-1111-1111-1111-111111111111", "3", "Cek panel", "Strobo", "active", "2026-09-25", "Agas", "catatan", "Ya"],
  ]);

  const [row] = await readTasksSheet(sheets, "sheet-1", "TASKS");
  assert.deepEqual(row?.assigneeNames, ["Agas"], "positional reading would have found the admin note here");
  assert.equal(row?.adminNote, "catatan", "and would have written \"Ya\" here");
  assert.equal(row?.scheduledText, "", "the column that does not exist yet is empty, not borrowed from a neighbour");
});

// A column the lock depends on is different: without task_id or version
// there is no safe way to proceed at all.
test("a sheet missing a column the import cannot do without is refused", async () => {
  const sheets = fakeSheetsReturning([
    ["Judul", "Proyek", "Status"],
    ["Cek panel", "Strobo", "active"],
  ]);

  await assert.rejects(() => readTasksSheet(sheets, "sheet-1", "TASKS"), /task_id/);
});

test("an empty sheet reads as no rows rather than throwing", async () => {
  const [none] = [await readTasksSheet(fakeSheetsReturning([]), "sheet-1", "TASKS")];
  assert.deepEqual(none, []);
});

// ---------------------------------------------------------------------
// Plan tasks (src/plan/) follow an external spreadsheet. The plan sync
// rewrites their fields every fifteen minutes, so an edit made in TASKS
// would be undone silently; the import rejects it, says why, and writes
// nothing.
// ---------------------------------------------------------------------

async function planTask(db: Awaited<ReturnType<typeof createTestDb>>) {
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const other = await createMember(db, { preferredName: "Orang Lain" });
  const project = await createProject(db, { name: "Aerolift Drone Mobil", createdByMemberId: admin.memberId });
  await confirmProject(db, project.projectId);
  const other2 = await createProject(db, { name: "Proyek Lain", createdByMemberId: admin.memberId });
  await confirmProject(db, other2.projectId);
  const task = await createTask(db, {
    title: "BMS Drone Kestrel: Soldering PCB BMS 4S",
    createdByMemberId: admin.memberId,
    projectId: project.projectId,
    sourceReference: "master-plan-aerolift:1.01",
  });
  return { admin, other, task };
}

test("every editable field of a plan task is rejected, with a reason, and nothing is written", async () => {
  const db = await createTestDb();
  const { task } = await planTask(db);

  const summary = await diffAndApplyTasksImport(
    db,
    [
      row({
        taskId: task.taskId,
        sheetVersion: task.version,
        title: "Judul baru",
        projectText: "Proyek Lain",
        status: "done",
        deadlineText: "2026-12-01",
        scheduledText: "2026-11-30",
        assigneeNames: ["Orang Lain"],
        adminNote: "catatan baru",
      }),
    ],
    undefined,
    NOW,
  );

  assert.equal(summary.applied, 0);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.conflicts, 0);
  const after = await getTask(db, task.taskId);
  assert.equal(after?.version, task.version, "no write, no version bump");
  assert.equal(after?.title, task.title);
  assert.equal(after?.status, task.status);
  assert.equal(after?.projectId, task.projectId);
  assert.equal(after?.deadlineLabel, null);
  assert.equal(after?.adminNote, null);
  assert.equal((await db.select().from(taskAssignees).where(eq(taskAssignees.taskId, task.taskId))).length, 0);
  assert.equal((await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.taskId))).length, 0);

  const [event] = await db.select().from(sheetsSyncEvents);
  assert.equal(event?.status, "rejected");
  const detail = event?.detail as { rejectedFields: string[]; reason: string };
  assert.deepEqual(
    [...detail.rejectedFields].sort(),
    ["adminNote", "assignees", "deadline", "project", "scheduled", "status", "title"],
  );
  assert.match(detail.reason, /plan spreadsheet/);
});

test("an ordinary task is still editable — the lock is only for plan tasks", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId, sourceReference: "chat:abc" });

  const summary = await diffAndApplyTasksImport(db, [row({ taskId: task.taskId, sheetVersion: task.version, title: "Cek panel B Utama" })], undefined, NOW);

  assert.equal(summary.applied, 1);
  assert.equal(summary.rejected, 0);
});

test("the plan sync moving a plan task is not mistaken for an edit: untouched cells are not rejected", async () => {
  const db = await createTestDb();
  const { task } = await planTask(db);
  await saveTasksSnapshot(db, await buildTasksRows(db));

  // What the plan sync does between two exports: status and title move, the sheet still shows the old row.
  await db.update(tasks).set({ status: "in_progress", title: "BMS Drone Kestrel: Soldering PCB BMS 4S (revisi)", version: task.version + 1 }).where(eq(tasks.taskId, task.taskId));

  const summary = await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: task.version, title: task.title, status: "active", projectText: "Aerolift Drone Mobil" })],
    undefined,
    NOW,
  );

  assert.equal(summary.rejected, 0);
  assert.equal(summary.stale, 1);
  assert.equal((await db.select().from(sheetsSyncEvents)).length, 0);
});

test("on a plan task only the cell somebody changed is reported rejected", async () => {
  const db = await createTestDb();
  const { task } = await planTask(db);
  await saveTasksSnapshot(db, await buildTasksRows(db));

  await diffAndApplyTasksImport(
    db,
    [row({ taskId: task.taskId, sheetVersion: task.version, title: task.title, status: "active", adminNote: "tolong dikebut" })],
    undefined,
    NOW,
  );

  const [event] = await db.select().from(sheetsSyncEvents);
  assert.deepEqual((event?.detail as { rejectedFields: string[] }).rejectedFields, ["adminNote"]);
  assert.equal((await getTask(db, task.taskId))?.adminNote, null);
});
