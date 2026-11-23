import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import {
  createCandidateTask,
  incrementShownCount,
  listUnresolvedCandidates,
  promoteStaleCandidates,
  resolveCandidateAsActivityOnly,
  resolveCandidateAsTask,
} from "./candidates.ts";
import { getTask } from "./service.ts";

async function setupReportItem(db: Awaited<ReturnType<typeof createTestDb>>) {
  const member = await createMember(db, { preferredName: "Agas" });
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  const revision = await addRevision(db, report.reportId, "report\n- ganti sekring panel B");
  const item = await addReportItem(db, revision.revisionId, { activity: "ganti sekring panel B" });
  return { member, item };
}

// ACCEPTANCE_TESTS.md §3.1
test("new activity not matching any existing task creates a candidate task", async () => {
  const db = await createTestDb();
  const { member, item } = await setupReportItem(db);
  const candidate = await createCandidateTask(db, {
    reportItemId: item.itemId,
    createdByMemberId: member.memberId,
    suggestedTitle: "Ganti sekring panel B",
  });
  assert.equal(candidate.resolvedAt, null);
  const unresolved = await listUnresolvedCandidates(db);
  assert.deepEqual(
    unresolved.map((c) => c.candidateId),
    [candidate.candidateId],
  );
});

test("author can confirm their own candidate task, creating a real task", async () => {
  const db = await createTestDb();
  const { member, item } = await setupReportItem(db);
  const candidate = await createCandidateTask(db, {
    reportItemId: item.itemId,
    createdByMemberId: member.memberId,
    suggestedTitle: "Ganti sekring panel B",
  });

  const task = await resolveCandidateAsTask(db, candidate.candidateId);
  assert.equal(task.title, "Ganti sekring panel B");
  assert.deepEqual(await listUnresolvedCandidates(db), []);
});

test("resolving as activity-only leaves no task behind", async () => {
  const db = await createTestDb();
  const { member, item } = await setupReportItem(db);
  const candidate = await createCandidateTask(db, {
    reportItemId: item.itemId,
    createdByMemberId: member.memberId,
    suggestedTitle: "Ganti sekring panel B",
  });

  await resolveCandidateAsActivityOnly(db, candidate.candidateId);
  assert.deepEqual(await listUnresolvedCandidates(db), []);
});

test("candidate task unanswered after 3 morning summaries becomes active_unreviewed", async () => {
  const db = await createTestDb();
  const { member, item } = await setupReportItem(db);
  const candidate = await createCandidateTask(db, {
    reportItemId: item.itemId,
    createdByMemberId: member.memberId,
    suggestedTitle: "Ganti sekring panel B",
  });

  await incrementShownCount(db, candidate.candidateId);
  await incrementShownCount(db, candidate.candidateId);
  let promoted = await promoteStaleCandidates(db);
  assert.deepEqual(promoted, [], "should not promote before the 3rd summary");

  await incrementShownCount(db, candidate.candidateId);
  promoted = await promoteStaleCandidates(db);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0]?.status, "active_unreviewed");

  const stored = await getTask(db, promoted[0]!.taskId);
  assert.equal(stored?.status, "active_unreviewed");
  assert.deepEqual(await listUnresolvedCandidates(db), []);
});

test("promoteStaleCandidates does not touch candidates below the threshold", async () => {
  const db = await createTestDb();
  const { member, item } = await setupReportItem(db);
  await createCandidateTask(db, {
    reportItemId: item.itemId,
    createdByMemberId: member.memberId,
    suggestedTitle: "Ganti sekring panel B",
  });
  assert.deepEqual(await promoteStaleCandidates(db), []);
});
