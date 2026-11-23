import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testing.ts";
import { createMember } from "../members/service.ts";
import { createProject } from "../projects/service.ts";
import { dailyReports, pendingActions, tasks } from "./schema.ts";

// Chief-review findings: constraints that were missing before this pass.
test("daily_reports rejects a second row for the same member+day (corrections must use report_revisions instead)", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await db.insert(dailyReports).values({ memberId: member.memberId, reportingDay: "2026-08-07" });

  await assert.rejects(() => db.insert(dailyReports).values({ memberId: member.memberId, reportingDay: "2026-08-07" }));
});

test("daily_reports allows the same member to report on a different day", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await db.insert(dailyReports).values({ memberId: member.memberId, reportingDay: "2026-08-07" });
  await assert.doesNotReject(() =>
    db.insert(dailyReports).values({ memberId: member.memberId, reportingDay: "2026-08-08" }),
  );
});

test("pending_actions rejects a second open proposal of the same type on the same task", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const member = await createMember(db, { preferredName: "Agas" });
  const project = await createProject(db, { name: "Panel Upgrade" });
  const [task] = await db
    .insert(tasks)
    .values({ title: "Fix panel", normalizedTitle: "fix panel", projectId: project.projectId, createdByMemberId: admin.memberId })
    .returning();
  if (!task) throw new Error("task insert returned no row");

  await db.insert(pendingActions).values({ taskId: task.taskId, actionType: "cancellation", requestedByMemberId: member.memberId });

  await assert.rejects(() =>
    db.insert(pendingActions).values({ taskId: task.taskId, actionType: "cancellation", requestedByMemberId: member.memberId }),
  );
});

test("pending_actions allows a new proposal once the prior one is decided", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin", role: "admin" });
  const member = await createMember(db, { preferredName: "Agas" });
  const project = await createProject(db, { name: "Panel Upgrade" });
  const [task] = await db
    .insert(tasks)
    .values({ title: "Fix panel", normalizedTitle: "fix panel", projectId: project.projectId, createdByMemberId: admin.memberId })
    .returning();
  if (!task) throw new Error("task insert returned no row");

  const [first] = await db
    .insert(pendingActions)
    .values({ taskId: task.taskId, actionType: "cancellation", requestedByMemberId: member.memberId })
    .returning();
  if (!first) throw new Error("pending action insert returned no row");

  await db
    .update(pendingActions)
    .set({ state: "rejected", decidedByMemberId: admin.memberId, decidedAt: new Date() })
    .where(eq(pendingActions.pendingActionId, first.pendingActionId));

  await assert.doesNotReject(() =>
    db.insert(pendingActions).values({ taskId: task.taskId, actionType: "cancellation", requestedByMemberId: member.memberId }),
  );
});
