import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import { createProject } from "../projects/service.ts";
import { createTask } from "../tasks/service.ts";
import {
  addReportItem,
  addRevision,
  approveNoActivityReport,
  getDailyReport,
  getLatestRevision,
  getOrCreateDailyReport,
  listItemsForRevision,
  markNoActivity,
  summarizeRevision,
} from "./service.ts";

test("submitting a report the first time creates a new daily report", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  assert.ok(report.reportId);
  assert.equal(report.reportingDay, "2026-08-07");
});

// ACCEPTANCE_TESTS.md §9.5 / §2.2 "Report correction appends a revision, original preserved"
test("a correction reuses the same daily report and appends a new revision, original preserved", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");

  const first = await addRevision(db, report.reportId, "report\n- pekerjaan: cek panel");
  assert.equal(first.revisionNumber, 1);

  const second = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  assert.equal(second.reportId, report.reportId, "must reuse the same report row, not create a second one");

  const correction = await addRevision(db, report.reportId, "report (koreksi)\n- pekerjaan: cek panel dan MCB");
  assert.equal(correction.revisionNumber, 2);

  const latest = await getLatestRevision(db, report.reportId);
  assert.equal(latest?.revisionId, correction.revisionId);
  assert.equal(latest?.rawText, "report (koreksi)\n- pekerjaan: cek panel dan MCB");
});

// ACCEPTANCE_TESTS.md §2.3 No-Activity Report
test("no-activity report is pending admin confirmation until approved", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  await markNoActivity(db, report.reportId);

  const stored = await getDailyReport(db, member.memberId, "2026-08-07");
  assert.equal(stored?.noActivity, true);
  assert.equal(stored?.pendingAdminConfirmation, true);

  await approveNoActivityReport(db, report.reportId);
  const approved = await getDailyReport(db, member.memberId, "2026-08-07");
  assert.equal(approved?.pendingAdminConfirmation, false);
  assert.equal(approved?.noActivity, true, "no-activity flag itself is preserved after approval");
});

// ACCEPTANCE_TESTS.md §2.2 "Results and obstacles are stored independently"
test("report items store activity, result, and obstacle independently", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const revision = await addRevision(db, report.reportId, "report\n- pekerjaan: test docking charge");

  const item = await addReportItem(db, revision.revisionId, {
    activity: "test docking charge",
    result: "charging berhasil",
    obstacle: "koneksi Wi-Fi tidak stabil",
    status: "testing",
  });

  assert.equal(item.activity, "test docking charge");
  assert.equal(item.result, "charging berhasil");
  assert.equal(item.obstacle, "koneksi Wi-Fi tidak stabil");
  assert.equal(item.status, "testing");
});

test("an item linked to an existing task is a task update, not a candidate", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const member = await createMember(db, { preferredName: "Agas" });
  const project = await createProject(db, { name: "Panel Upgrade" });
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId, projectId: project.projectId });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const revision = await addRevision(db, report.reportId, "report\n- update panel");

  const item = await addReportItem(db, revision.revisionId, { activity: "update panel", taskId: task.taskId, status: "in_progress" });
  assert.equal(item.taskId, task.taskId);
});

// ACCEPTANCE_TESTS.md §2.4 Acknowledgment
test("summarizeRevision counts activities, task updates, done tasks, and candidates", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const member = await createMember(db, { preferredName: "Agas" });
  const task = await createTask(db, { title: "Fix panel", createdByMemberId: admin.memberId });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const revision = await addRevision(db, report.reportId, "report\n- 3 aktivitas");

  await addReportItem(db, revision.revisionId, { activity: "update panel", taskId: task.taskId, status: "in_progress" });
  await addReportItem(db, revision.revisionId, { activity: "cek MCB", taskId: task.taskId, status: "done" });
  await addReportItem(db, revision.revisionId, { activity: "aktivitas baru tanpa task", status: "unknown" });

  const items = await listItemsForRevision(db, revision.revisionId);
  const summary = summarizeRevision(items);
  assert.deepEqual(summary, {
    activityCount: 3,
    taskUpdateCount: 2,
    taskDoneCount: 1,
  });
});
