import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { createTask } from "../tasks/service.ts";
import { buildDailyReportsRows, buildMembersRows, buildReportItemsRows } from "./export.ts";

test("buildMembersRows never includes a JID or any member_identifiers data", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas", whatsappJid: "628111@s.whatsapp.net" });
  await setMembershipStatus(db, member.memberId, "active");

  const rows = await buildMembersRows(db);
  assert.equal(rows[0]?.[1], "Nama");
  const dataRow = rows.find((r) => r[0] === member.memberId);
  assert.ok(dataRow);
  assert.ok(!dataRow.some((cell) => cell.includes("@s.whatsapp.net")), "no JID should ever appear in a MEMBERS row");
  assert.equal(dataRow[1], "Agas");
  assert.equal(dataRow[3], "active");
});

test("buildDailyReportsRows aggregates item count and last revision number correctly", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const rev1 = await addRevision(db, report.reportId, "report\n- item satu");
  await addReportItem(db, rev1.revisionId, { activity: "item satu" });
  const rev2 = await addRevision(db, report.reportId, "report\n- item satu\n- item dua (revisi)");
  await addReportItem(db, rev2.revisionId, { activity: "item satu" });
  await addReportItem(db, rev2.revisionId, { activity: "item dua" });

  const rows = await buildDailyReportsRows(db);
  const dataRow = rows.find((r) => r[0] === "2026-08-07");
  assert.ok(dataRow);
  assert.equal(dataRow[1], "Agas");
  assert.equal(dataRow[3], "3", "item count sums items across all revisions of the report");
  assert.equal(dataRow[4], "2", "last revision number should be the highest revisionNumber");
});

test("buildReportItemsRows joins through to the report's date, member name, and matched task title", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const task = await createTask(db, { title: "Cek panel B", createdByMemberId: admin.memberId });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const revision = await addRevision(db, report.reportId, "report\n- cek panel B");
  await addReportItem(db, revision.revisionId, {
    activity: "cek panel B",
    result: "aman",
    obstacle: "kabel kurang",
    status: "in_progress",
    taskId: task.taskId,
  });

  const rows = await buildReportItemsRows(db);
  const dataRow = rows.find((r) => r[3] === "cek panel B");
  assert.ok(dataRow);
  assert.equal(dataRow[0], "2026-08-07");
  assert.equal(dataRow[1], "Agas");
  assert.equal(dataRow[2], "Cek panel B");
  assert.equal(dataRow[4], "aman");
  assert.equal(dataRow[5], "Ya", "obstacle presence is reduced to Ya/Tidak, not free text, per the public-link privacy call");
  assert.equal(dataRow[6], "in_progress");
});
