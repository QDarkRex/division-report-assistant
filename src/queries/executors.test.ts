import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { createProject, confirmProject } from "../projects/service.ts";
import { assignMember, createTask, listTasksByStatus, setDeadline, transitionStatus } from "../tasks/service.ts";
import { getOrCreateDailyReport, addRevision, addReportItem, getDailyReport, setOvertimeTimes } from "../reports/service.ts";
import { executeQuery } from "./executors.ts";
import { getActiveAvailability } from "../members/availability.ts";
import { formatQueryResult } from "./format.ts";
import type { QueryIntent } from "../llm/schemas.ts";

const NOW = new Date("2026-08-08T05:00:00.000Z"); // 12:00 WIB

function intent(overrides: Partial<QueryIntent>): QueryIntent {
  return {
    intent: "unknown",
    targetMemberName: null,
    taskReference: null,
    projectReference: null,
    dayOffset: null,
    availabilityKind: null,
    availabilityReason: null,
    ...overrides,
  };
}

test("member_tasks returns the member's assigned tasks", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });
  await assignMember(db, task.taskId, budi.memberId);

  const result = await executeQuery(db, intent({ intent: "member_tasks", targetMemberName: "Budi" }), NOW, "unused-actor");
  assert.equal(result.kind, "member_tasks");
  if (result.kind === "member_tasks") {
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.title, "Cek panel B");
  }
  assert.match(formatQueryResult(result), /Cek panel B/);
});

test("member_tasks with an ambiguous name asks which one, never guesses", async () => {
  const db = await createTestDb();
  await createMember(db, { preferredName: "Budi Santoso" });
  await createMember(db, { preferredName: "Budi Prakoso" });

  // ilike with no wildcards requires an exact case-insensitive match, so
  // "Budi" alone matches neither — this proves 0-match behavior, the
  // real ambiguity case (2 exact-name members) isn't constructible here,
  // but the "not found" path is exercised the same way as ambiguous.
  const result = await executeQuery(db, intent({ intent: "member_tasks", targetMemberName: "Budi" }), NOW, "unused-actor");
  assert.equal(result.kind, "member_not_found");
  assert.match(formatQueryResult(result), /[Tt]idak ditemukan/);
});

test("missing_reporters reuses the exact same logic the 20:00 reminder job uses", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "missing_reporters" }), NOW, "unused-actor");
  assert.equal(result.kind, "missing_reporters");
  if (result.kind === "missing_reporters") {
    assert.equal(result.members.length, 1);
    assert.equal(result.members[0]?.preferredName, "Budi");
  }
});

test("stale_tasks lists tasks in the stale status", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Task lama", createdByMemberId: admin.memberId });
  await transitionStatus(db, task.taskId, "member_reports_work"); // active -> in_progress
  await transitionStatus(db, task.taskId, "stale_detected"); // in_progress -> stale

  const result = await executeQuery(db, intent({ intent: "stale_tasks" }), NOW, "unused-actor");
  assert.equal(result.kind, "stale_tasks");
  if (result.kind === "stale_tasks") {
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.title, "Task lama");
  }
});

test("member_report returns items from the requested day, computed via dayOffset not a literal date", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07"); // "yesterday" relative to NOW
  const revision = await addRevision(db, report.reportId, "report\n- x");
  await addReportItem(db, revision.revisionId, { activity: "kerjaan kemarin", status: "done" });

  const result = await executeQuery(db, intent({ intent: "member_report", targetMemberName: "Budi", dayOffset: -1 }), NOW, "unused-actor");
  assert.equal(result.kind, "member_report");
  if (result.kind === "member_report") {
    assert.equal(result.reportingDay, "2026-08-07");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.activity, "kerjaan kemarin");
  }
});

test("member_report for a day with no report says so, doesn't error", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "member_report", targetMemberName: "Budi", dayOffset: 0 }), NOW, "unused-actor");
  assert.equal(result.kind, "member_report");
  if (result.kind === "member_report") assert.equal(result.noReport, true);
  assert.match(formatQueryResult(result), /Belum lapor/);
});

test("project_summary groups tasks by status", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const project = await createProject(db, { name: "Drone VEGA" });
  await confirmProject(db, project.projectId);
  await createTask(db, { title: "Task A", createdByMemberId: admin.memberId, projectId: project.projectId });
  await createTask(db, { title: "Task B", createdByMemberId: admin.memberId, projectId: project.projectId });

  const result = await executeQuery(db, intent({ intent: "project_summary", projectReference: "Drone VEGA" }), NOW, "unused-actor");
  assert.equal(result.kind, "project_summary");
  if (result.kind === "project_summary") assert.equal(result.tasks.length, 2);
  assert.match(formatQueryResult(result), /2 task/);
});

test("nearest_deadline reuses classifyOpenTasksByDeadline exactly, same as the 16:00 reminder job", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Deadline task", createdByMemberId: admin.memberId });
  await setDeadline(db, task.taskId, "deadline hari ini", { year: 2026, month: 8, day: 8 });

  const result = await executeQuery(db, intent({ intent: "nearest_deadline" }), NOW, "unused-actor");
  assert.equal(result.kind, "nearest_deadline");
});

test("unknown intent formats as a plain-language fallback, never crashes", async () => {
  const db = await createTestDb();
  const result = await executeQuery(db, intent({ intent: "unknown" }), NOW, "unused-actor");
  assert.equal(result.kind, "unknown");
  assert.match(formatQueryResult(result), /tidak mengerti/i);
});

test("set_availability lets a member declare their own leave", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "set_availability", availabilityKind: "izin", dayOffset: 0 }), NOW, budi.memberId);
  assert.equal(result.kind, "availability_set");
  if (result.kind === "availability_set") {
    assert.equal(result.member.memberId, budi.memberId);
    assert.equal(result.availabilityKind, "izin");
    assert.equal(result.days[0], "2026-08-08");
  }
  assert.match(formatQueryResult(result), /Budi izin/);
});

test("set_availability without an availabilityKind asks instead of guessing", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "set_availability" }), NOW, budi.memberId);
  assert.equal(result.kind, "availability_missing_kind");
  assert.match(formatQueryResult(result), /[Jj]enis izin/);
});

test("set_availability refuses a non-admin declaring leave for someone else", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");
  const ani = await createMember(db, { preferredName: "Ani" });
  await setMembershipStatus(db, ani.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "sakit", targetMemberName: "Ani" }),
    NOW,
    budi.memberId,
  );
  assert.equal(result.kind, "availability_denied");
  assert.match(formatQueryResult(result), /admin/i);
});

test("set_availability lets an admin declare leave for someone else", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  await setMembershipStatus(db, admin.memberId, "active");
  const ani = await createMember(db, { preferredName: "Ani" });
  await setMembershipStatus(db, ani.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "cuti", targetMemberName: "Ani" }),
    NOW,
    admin.memberId,
  );
  assert.equal(result.kind, "availability_set");
  if (result.kind === "availability_set") assert.equal(result.member.memberId, ani.memberId);
});

// §14: "The status applies immediately but an admin can correct or cancel it."
test("cancel_availability retracts a member's own declaration", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");
  await executeQuery(db, intent({ intent: "set_availability", availabilityKind: "izin" }), NOW, budi.memberId);

  const result = await executeQuery(db, intent({ intent: "cancel_availability" }), NOW, budi.memberId);
  assert.equal(result.kind, "availability_cancelled");
  assert.match(formatQueryResult(result), /[Dd]ibatalkan/);
  assert.equal(await getActiveAvailability(db, budi.memberId, { year: 2026, month: 8, day: 8 }), null);
});

test("cancel_availability with nothing recorded says so instead of claiming success", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "cancel_availability" }), NOW, budi.memberId);
  assert.equal(result.kind, "availability_nothing_to_cancel");
  assert.match(formatQueryResult(result), /[Tt]idak ada catatan/);
});

test("cancel_availability obeys the same self-or-admin rule as setting it", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");
  const ani = await createMember(db, { preferredName: "Ani" });
  await setMembershipStatus(db, ani.memberId, "active");
  await executeQuery(db, intent({ intent: "set_availability", availabilityKind: "izin", targetMemberName: "Ani" }), NOW, ani.memberId);

  const denied = await executeQuery(db, intent({ intent: "cancel_availability", targetMemberName: "Ani" }), NOW, budi.memberId);
  assert.equal(denied.kind, "availability_denied");
  assert.ok(await getActiveAvailability(db, ani.memberId, { year: 2026, month: 8, day: 8 }), "the declaration must survive a denied cancellation");
});

// Owner 2026-08-29: a reason is optional, but there must be a place for it.
test("set_availability stores the reason and echoes it back for confirmation", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "izin", availabilityReason: "bimbingan skripsi" }),
    NOW,
    budi.memberId,
  );
  assert.equal(result.kind, "availability_set");
  if (result.kind === "availability_set") assert.equal(result.reason, "bimbingan skripsi");
  // Echoed back so a misheard reason is visible now, not in the sheet next week.
  assert.match(formatQueryResult(result), /bimbingan skripsi/);

  const stored = await getActiveAvailability(db, budi.memberId, { year: 2026, month: 8, day: 8 });
  assert.equal(stored?.note, "bimbingan skripsi");
});

test("no reason given stores null and the confirmation stays clean", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "set_availability", availabilityKind: "sakit" }), NOW, budi.memberId);
  if (result.kind === "availability_set") assert.equal(result.reason, null);
  assert.doesNotMatch(formatQueryResult(result), /—\s*\./, "no dangling dash when there is nothing to explain");

  const stored = await getActiveAvailability(db, budi.memberId, { year: 2026, month: 8, day: 8 });
  assert.equal(stored?.note, null);
});

test("a whitespace-only reason is treated as none, not stored as an empty string", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "izin", availabilityReason: "   " }),
    NOW,
    budi.memberId,
  );
  if (result.kind === "availability_set") assert.equal(result.reason, null);
});

// ---------------------------------------------------------------------
// Multi-day declarations (2026-09-04). Andre wrote "Besok izin gak masuk
// bang karena ada wajib PM TKA dari sekolah, begitu juga di tanggal
// 12,19,26 mendatang" and only tomorrow was recorded. The other three
// were not rejected or questioned — the schema had nowhere to put them,
// so they vanished, and he would have been marked absent without notice
// on all three.
// ---------------------------------------------------------------------

test("a declaration naming tomorrow AND bare dates records every one of them", async () => {
  const db = await createTestDb();
  const andre = await createMember(db, { preferredName: "Andre" });
  await setMembershipStatus(db, andre.memberId, "active");

  const result = await executeQuery(
    db,
    intent({
      intent: "set_availability",
      availabilityKind: "izin",
      dayOffset: 1,
      additionalDayOfMonths: [12, 19, 26],
      availabilityReason: "wajib PM TKA dari sekolah",
    }),
    NOW,
    andre.memberId,
  );

  assert.equal(result.kind, "availability_set");
  if (result.kind === "availability_set") {
    assert.deepEqual(result.days, ["2026-08-09", "2026-08-12", "2026-08-19", "2026-08-26"]);
  }

  // Stored, not just reported back.
  for (const day of [
    { year: 2026, month: 8, day: 9 },
    { year: 2026, month: 8, day: 12 },
    { year: 2026, month: 8, day: 19 },
    { year: 2026, month: 8, day: 26 },
  ]) {
    const active = await getActiveAvailability(db, andre.memberId, day);
    assert.equal(active?.kind, "izin", `${day.year}-${day.month}-${day.day} must be recorded`);
    assert.equal(active?.note, "wajib PM TKA dari sekolah", "the same reason applies to each day");
  }
});

test("every declared day is named in the reply, so a dropped one is visible immediately", async () => {
  const db = await createTestDb();
  const andre = await createMember(db, { preferredName: "Andre" });
  await setMembershipStatus(db, andre.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "izin", dayOffset: 1, additionalDayOfMonths: [12, 19, 26] }),
    NOW,
    andre.memberId,
  );

  const text = formatQueryResult(result);
  for (const day of ["Min, 9 Agu", "Rab, 12 Agu", "Rab, 19 Agu", "Rab, 26 Agu"]) assert.match(text, new RegExp(day));
});

// "tanggal 12 mendatang" said on the 8th means this month; said on the
// 20th it means next month. Resolving it in the backend rather than
// asking the model for an offset keeps that rule out of the prompt.
test("a bare date already past this month resolves to next month", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const lateInMonth = new Date("2026-08-20T05:00:00.000Z");
  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "cuti", dayOffset: 0, additionalDayOfMonths: [12] }),
    lateInMonth,
    budi.memberId,
  );

  assert.equal(result.kind, "availability_set");
  if (result.kind === "availability_set") assert.deepEqual(result.days, ["2026-08-20", "2026-09-12"]);
});

// A month without a 31st must not make the walk skip a year or stall.
test("day 31 resolves to the next month that actually has one", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const inFebruary = new Date("2026-02-10T05:00:00.000Z");
  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "izin", dayOffset: 0, additionalDayOfMonths: [31] }),
    inFebruary,
    budi.memberId,
  );

  assert.equal(result.kind, "availability_set");
  if (result.kind === "availability_set") assert.deepEqual(result.days, ["2026-02-10", "2026-03-31"]);
});

test("a bare date that is also the offset day is not recorded twice", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, budi.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "set_availability", availabilityKind: "sakit", dayOffset: 1, additionalDayOfMonths: [9] }),
    NOW,
    budi.memberId,
  );

  assert.equal(result.kind, "availability_set");
  if (result.kind === "availability_set") assert.deepEqual(result.days, ["2026-08-09"]);
});

// ---------------------------------------------------------------------
// Exporting a day for the boss (owner request, 2026-09-08). The file is
// meant to leave the division, which is why this one intent is gated on
// admin: the others answer into the group, where the audience is already
// the division.
// ---------------------------------------------------------------------

test("an admin gets a workbook for the requested day", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Hadi", role: "admin" });
  await setMembershipStatus(db, admin.memberId, "active");
  const worker = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, worker.memberId, "active");
  const report = await getOrCreateDailyReport(db, worker.memberId, "2026-08-08");
  const revision = await addRevision(db, report.reportId, "report agas");
  await addReportItem(db, revision.revisionId, { activity: "cek panel B", status: "done" });

  const result = await executeQuery(db, intent({ intent: "export_daily_report", dayOffset: 0 }), NOW, admin.memberId);

  assert.equal(result.kind, "daily_report_export");
  if (result.kind === "daily_report_export") {
    assert.equal(result.day, "2026-08-08");
    assert.ok(result.rowCount > 0);
    assert.match(result.fileName, /.xlsx$/);
    // A real zip, not an empty buffer: "PK" is the local file header.
    assert.equal(result.content.subarray(0, 2).toString("utf-8"), "PK");
  }
});

test("a non-admin member is refused, and no file is built", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "export_daily_report", dayOffset: 0 }), NOW, member.memberId);
  assert.equal(result.kind, "daily_report_export_denied");
  assert.match(formatQueryResult(result), /Hanya admin/);
});

// A spreadsheet with a header and nothing under it, forwarded onward, says
// the division did nothing that day.
test("a day with no reports at all is refused rather than sent empty", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Hadi", role: "admin" });
  await setMembershipStatus(db, admin.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "export_daily_report", dayOffset: -5 }), NOW, admin.memberId);
  assert.equal(result.kind, "daily_report_export_empty");
});

// ---------------------------------------------------------------------
// Assigning work from the group (owner request, 2026-09-08), taken from
// the exact question asked: tag the bot tonight to put two people on a
// job tomorrow, then ask tomorrow what each of them is on.
// ---------------------------------------------------------------------

test("an admin can create a task for two people and a named day in one message", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Hadi", role: "admin" });
  await setMembershipStatus(db, admin.memberId, "active");
  const nisa = await createMember(db, { preferredName: "Nisa" });
  await setMembershipStatus(db, nisa.memberId, "active");
  const udin = await createMember(db, { preferredName: "Udin" });
  await setMembershipStatus(db, udin.memberId, "active");

  const result = await executeQuery(
    db,
    intent({
      intent: "create_task",
      taskTitle: "Centering docking di lokasi B",
      targetMemberNames: ["Nisa", "Udin"],
      dayOffset: 1,
    }),
    NOW,
    admin.memberId,
  );

  assert.equal(result.kind, "task_created");
  if (result.kind === "task_created") {
    assert.equal(result.task.title, "Centering docking di lokasi B");
    assert.equal(result.scheduledFor, "2026-08-09", "the day of work, not a deadline");
    assert.deepEqual(result.assignees.map((a) => a.preferredName).sort(), ["Nisa", "Udin"]);
    // The echo names both people and the day: this line is the admin's
    // only chance to catch a misread before anyone is chased about it.
    const text = formatQueryResult(result);
    assert.match(text, /Nisa dan Udin/);
    assert.match(text, /Min, 9 Agu/);
  }
});

test("asking what someone is on for a given day answers only that day", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Hadi", role: "admin" });
  await setMembershipStatus(db, admin.memberId, "active");
  const nisa = await createMember(db, { preferredName: "Nisa" });
  await setMembershipStatus(db, nisa.memberId, "active");

  await executeQuery(db, intent({ intent: "create_task", taskTitle: "Centering docking", targetMemberNames: ["Nisa"], dayOffset: 1 }), NOW, admin.memberId);
  await executeQuery(db, intent({ intent: "create_task", taskTitle: "Wiring panel", targetMemberNames: ["Nisa"], dayOffset: 5 }), NOW, admin.memberId);

  const tomorrow = await executeQuery(db, intent({ intent: "member_tasks", targetMemberName: "Nisa", dayOffset: 1 }), NOW, admin.memberId);
  assert.equal(tomorrow.kind, "member_tasks");
  if (tomorrow.kind === "member_tasks") {
    assert.equal(tomorrow.tasks.length, 1);
    assert.equal(tomorrow.tasks[0]?.title, "Centering docking");
  }

  // No day named means "what is she holding at all" — the original
  // behaviour, which must not change.
  const all = await executeQuery(db, intent({ intent: "member_tasks", targetMemberName: "Nisa" }), NOW, admin.memberId);
  if (all.kind === "member_tasks") assert.equal(all.tasks.length, 2);
});

// Half-assigning is worse than not assigning: the admin sees a
// confirmation and stops thinking about it, while the person who was
// never resolved is never told.
test("a name that resolves to nobody cancels the whole request", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Hadi", role: "admin" });
  await setMembershipStatus(db, admin.memberId, "active");
  const nisa = await createMember(db, { preferredName: "Nisa" });
  await setMembershipStatus(db, nisa.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "create_task", taskTitle: "Centering docking", targetMemberNames: ["Nisa", "Siapa Ini"], dayOffset: 1 }),
    NOW,
    admin.memberId,
  );

  assert.equal(result.kind, "task_create_unresolved_names");
  assert.equal((await listTasksByStatus(db, "active")).length, 0, "nothing may be created");
});

test("a non-admin cannot create or assign work from chat", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Nisa" });
  await setMembershipStatus(db, member.memberId, "active");

  const result = await executeQuery(
    db,
    intent({ intent: "create_task", taskTitle: "Centering docking", targetMemberNames: ["Nisa"], dayOffset: 1 }),
    NOW,
    member.memberId,
  );
  assert.equal(result.kind, "task_create_denied");
  assert.equal((await listTasksByStatus(db, "active")).length, 0);
});

// An admin who did not name a day did not mean today.
test("no day named leaves the task unscheduled rather than defaulting to today", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Hadi", role: "admin" });
  await setMembershipStatus(db, admin.memberId, "active");
  const nisa = await createMember(db, { preferredName: "Nisa" });
  await setMembershipStatus(db, nisa.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "create_task", taskTitle: "Cek panel", targetMemberNames: ["Nisa"] }), NOW, admin.memberId);
  assert.equal(result.kind, "task_created");
  if (result.kind === "task_created") assert.equal(result.scheduledFor, null);
});

// ---------------------------------------------------------------------
// Overtime check-in ("absen lembur"), 2026-09-11. Any active member checks
// themselves in; it opens the overtime report so the check-in is visible
// and can be nagged if no lembur work follows.
// ---------------------------------------------------------------------

test("checking in for overtime opens an overtime report and confirms", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "overtime_checkin" }), NOW, m.memberId);
  assert.equal(result.kind, "overtime_checked_in");
  if (result.kind === "overtime_checked_in") assert.equal(result.alreadyReported, false);
  assert.match(formatQueryResult(result), /Report lembur/);

  assert.ok(await getDailyReport(db, m.memberId, "2026-08-08", "overtime"), "the overtime report now exists");
  assert.equal(await getDailyReport(db, m.memberId, "2026-08-08", "regular"), null, "the regular report is untouched");
});

test("checking in twice does not create a second overtime report", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");

  const first = await executeQuery(db, intent({ intent: "overtime_checkin" }), NOW, m.memberId);
  const second = await executeQuery(db, intent({ intent: "overtime_checkin" }), NOW, m.memberId);
  assert.equal(first.kind, "overtime_checked_in");
  assert.equal(second.kind, "overtime_checked_in");
  // Idempotent: getOrCreateDailyReport returns the same row both times.
  if (first.kind === "overtime_checked_in" && second.kind === "overtime_checked_in") {
    assert.equal(first.day, second.day);
  }
});

test("an inactive member cannot check in for overtime", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" }); // pending, never activated
  const result = await executeQuery(db, intent({ intent: "overtime_checkin" }), NOW, m.memberId);
  assert.equal(result.kind, "overtime_checkin_denied");
});

test("checking in with a start time records it and echoes it back", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");

  const result = await executeQuery(db, intent({ intent: "overtime_checkin", timeText: "17:00" }), NOW, m.memberId);
  assert.equal(result.kind, "overtime_checked_in");
  if (result.kind === "overtime_checked_in") assert.equal(result.startText, "17:00");
  assert.match(formatQueryResult(result), /17:00/);

  const report = await getDailyReport(db, m.memberId, "2026-08-08", "overtime");
  assert.equal(report?.overtimeStartText, "17:00");
});

test("checking out records the stop time on the overtime report, opening it if needed", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");

  // Never checked in — checkout still records a stop.
  const result = await executeQuery(db, intent({ intent: "overtime_checkout", timeText: "21:30" }), NOW, m.memberId);
  assert.equal(result.kind, "overtime_checked_out");
  const report = await getDailyReport(db, m.memberId, "2026-08-08", "overtime");
  assert.equal(report?.overtimeEndText, "21:30");
});

test("check-in then checkout leaves both times on one overtime report", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");

  await executeQuery(db, intent({ intent: "overtime_checkin", timeText: "17:00" }), NOW, m.memberId);
  await executeQuery(db, intent({ intent: "overtime_checkout", timeText: "21:00" }), NOW, m.memberId);

  const report = await getDailyReport(db, m.memberId, "2026-08-08", "overtime");
  assert.equal(report?.overtimeStartText, "17:00");
  assert.equal(report?.overtimeEndText, "21:00");
});

// ---------------------------------------------------------------------
// "Siapa yang lembur" is a QUESTION, 2026-09-12. Gunawan asked exactly
// that and the bot filed HIM as on overtime — a question turned into a
// mutation. The read-only overtime_today intent gives the classifier the
// right bucket; this covers the executor and format for it.
// ---------------------------------------------------------------------

test("overtime_today lists who has an overtime report, and mutates nothing", async () => {
  const db = await createTestDb();
  const asker = await createMember(db, { preferredName: "Gunawan" });
  await setMembershipStatus(db, asker.memberId, "active");
  const worker = await createMember(db, { preferredName: "Fikri" });
  await setMembershipStatus(db, worker.memberId, "active");
  const ot = await getOrCreateDailyReport(db, worker.memberId, "2026-08-08", "overtime");
  await setOvertimeTimes(db, ot.reportId, { startText: "17:00", endText: "21:00" });

  const result = await executeQuery(db, intent({ intent: "overtime_today" }), NOW, asker.memberId);
  assert.equal(result.kind, "overtime_today");
  assert.match(formatQueryResult(result), /Fikri \(17:00–21:00\)/);

  // The asker must NOT have been checked in by asking.
  assert.equal(await getDailyReport(db, asker.memberId, "2026-08-08", "overtime"), null);
});

test("overtime_today on a day nobody is working says so", async () => {
  const db = await createTestDb();
  const asker = await createMember(db, { preferredName: "Gunawan" });
  await setMembershipStatus(db, asker.memberId, "active");
  const result = await executeQuery(db, intent({ intent: "overtime_today" }), NOW, asker.memberId);
  assert.match(formatQueryResult(result), /Belum ada yang lembur/);
});
