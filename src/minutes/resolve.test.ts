import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { addAlias, createMember, setMembershipStatus } from "../members/service.ts";
import { confirmProject, createProject } from "../projects/service.ts";
import { fromJakartaWallClock } from "../shared/time.ts";
import { resolveActionItem, resolveDeadlineText } from "./resolve.ts";

const TODAY = { year: 2026, month: 8, day: 31 };
const NOW = fromJakartaWallClock(2026, 8, 31, 12, 0);

test("relative Indonesian dates resolve against the given day, never the real clock", () => {
  assert.deepEqual(resolveDeadlineText("hari ini", TODAY), TODAY);
  assert.deepEqual(resolveDeadlineText("besok", TODAY), { year: 2026, month: 9, day: 1 });
  assert.deepEqual(resolveDeadlineText("lusa", TODAY), { year: 2026, month: 9, day: 2 });
  assert.deepEqual(resolveDeadlineText("minggu depan", TODAY), { year: 2026, month: 9, day: 7 });
});

test("'tanggal N' still ahead this month stays in this month", () => {
  assert.deepEqual(resolveDeadlineText("deadline tanggal 31", TODAY), { year: 2026, month: 8, day: 31 });
});

// A date already past can only mean the next occurrence — reading it as
// this month would create a task that is overdue the moment it exists.
test("'tanggal N' already past rolls into next month, crossing the year correctly", () => {
  assert.deepEqual(resolveDeadlineText("tanggal 10", TODAY), { year: 2026, month: 9, day: 10 });
  assert.deepEqual(resolveDeadlineText("tgl 5", { year: 2026, month: 12, day: 20 }), { year: 2027, month: 1, day: 5 });
});

// Guessing a deadline is worse than having none: §7 makes the label
// mean "finish BEFORE that day", so a wrong guess misstates lateness.
test("an expression that is not unambiguous resolves to null rather than a guess", () => {
  assert.equal(resolveDeadlineText("secepatnya", TODAY), null);
  assert.equal(resolveDeadlineText("akhir bulan", TODAY), null);
  assert.equal(resolveDeadlineText("kalau sempat", TODAY), null);
});

test("an assignee named once and unambiguously is resolved to that member", async () => {
  const db = await createTestDb();
  const gunawan = await createMember(db, { preferredName: "Gunawan" });
  await setMembershipStatus(db, gunawan.memberId, "active");

  const resolved = await resolveActionItem(db, { title: "Wiring panel B", assigneeNames: ["Gunawan"] }, NOW);
  assert.deepEqual(resolved.assigneeMemberIds, [gunawan.memberId]);
  assert.deepEqual(resolved.unresolved, []);
});

test("an alias resolves to the same member — old names stay usable in minutes", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Gunawan" });
  await setMembershipStatus(db, member.memberId, "active");
  await addAlias(db, member.memberId, "Anggota-04");

  const resolved = await resolveActionItem(db, { title: "Wiring", assigneeNames: ["Anggota-04"] }, NOW);
  assert.deepEqual(resolved.assigneeMemberIds, [member.memberId]);
});

// The "never guess" rule: an unknown name must not silently drop, and
// must not attach the task to whoever happens to be closest.
test("an unknown name leaves the task unassigned and is reported, not guessed", async () => {
  const db = await createTestDb();
  await createMember(db, { preferredName: "Gunawan" }).then((m) => setMembershipStatus(db, m.memberId, "active"));

  const resolved = await resolveActionItem(db, { title: "Wiring", assigneeNames: ["Gunadi"] }, NOW);
  assert.deepEqual(resolved.assigneeMemberIds, []);
  assert.equal(resolved.unresolved.length, 1);
  assert.match(resolved.unresolved[0] ?? "", /Gunadi/);
  assert.equal(resolved.title, "Wiring", "the action item itself survives an unresolvable name");
});

test("one unresolvable name does not discard the assignees that did resolve", async () => {
  const db = await createTestDb();
  const gunawan = await createMember(db, { preferredName: "Gunawan" });
  await setMembershipStatus(db, gunawan.memberId, "active");

  const resolved = await resolveActionItem(db, { title: "Wiring", assigneeNames: ["Gunawan", "Entah"] }, NOW);
  assert.deepEqual(resolved.assigneeMemberIds, [gunawan.memberId]);
  assert.equal(resolved.unresolved.length, 1);
});

test("the deadline label is preserved verbatim alongside the computed day", async () => {
  const db = await createTestDb();
  const resolved = await resolveActionItem(db, { title: "Wiring", deadlineText: "tanggal 10" }, NOW);
  assert.equal(resolved.deadlineLabel, "tanggal 10", "§7 stores the label as written, not only the date");
  assert.deepEqual(resolved.deadlineDay, { year: 2026, month: 9, day: 10 });
});

test("an unresolvable deadline is reported while the task still gets created", async () => {
  const db = await createTestDb();
  const resolved = await resolveActionItem(db, { title: "Wiring", deadlineText: "secepatnya" }, NOW);
  assert.equal(resolved.deadlineDay, null);
  assert.equal(resolved.deadlineLabel, "secepatnya");
  assert.equal(resolved.unresolved.length, 1);
});

test("a named project resolves; an unknown one is reported without blocking the task", async () => {
  const db = await createTestDb();
  const project = await createProject(db, { name: "Drone VEGA" });
  await confirmProject(db, project.projectId);

  const ok = await resolveActionItem(db, { title: "Wiring", projectText: "Drone VEGA" }, NOW);
  assert.equal(ok.projectId, project.projectId);

  const unknown = await resolveActionItem(db, { title: "Wiring", projectText: "Proyek Hantu" }, NOW);
  assert.equal(unknown.projectId, null);
  assert.equal(unknown.unresolved.length, 1);
});

test("an action item with nothing but a title resolves cleanly", async () => {
  const db = await createTestDb();
  const resolved = await resolveActionItem(db, { title: "Beli kabel" }, NOW);
  assert.deepEqual(resolved, {
    title: "Beli kabel",
    notes: null,
    assigneeMemberIds: [],
    deadlineLabel: null,
    deadlineDay: null,
    projectId: null,
    unresolved: [],
  });
});
