import assert from "node:assert/strict";
import { test } from "node:test";
import { canRequestPendingAction } from "./pending-action.ts";
import { isValidStatusTransition } from "./state-machine.ts";

// Table from docs/division-report-assistant/ACCEPTANCE_TESTS.md §3.2
test("normal progress: active -> in_progress on member report", () => {
  assert.equal(isValidStatusTransition("active", "in_progress", "member_reports_work"), true);
});

test("completion: in_progress -> done", () => {
  assert.equal(isValidStatusTransition("in_progress", "done", "member_marks_done"), true);
});

// Chief-review finding: the acceptance table only exercises the happy edge
// (in_progress -> done); blocked/stale tasks must also be completable, or a
// single obstacle report permanently blocks a task from ever finishing.
test("completion is also reachable from blocked and stale, not just in_progress", () => {
  assert.equal(isValidStatusTransition("blocked", "done", "member_marks_done"), true);
  assert.equal(isValidStatusTransition("stale", "done", "member_marks_done"), true);
});

test("stale tasks can resume to in_progress", () => {
  assert.equal(isValidStatusTransition("stale", "in_progress", "resume_from_stale"), true);
});

test("paused is reachable and resumable", () => {
  assert.equal(isValidStatusTransition("in_progress", "paused", "admin_pause"), true);
  assert.equal(isValidStatusTransition("paused", "in_progress", "resume_from_pause"), true);
});

test("block report: in_progress -> blocked", () => {
  assert.equal(isValidStatusTransition("in_progress", "blocked", "obstacle_reported"), true);
});

test("block resolution: blocked -> in_progress", () => {
  assert.equal(isValidStatusTransition("blocked", "in_progress", "obstacle_resolved"), true);
});

test("stale detection: in_progress -> stale after 7 days no update", () => {
  assert.equal(isValidStatusTransition("in_progress", "stale", "stale_detected"), true);
});

test("admin cancel: any status -> cancelled", () => {
  for (const from of ["active", "in_progress", "blocked", "paused", "stale", "status_conflict"] as const) {
    assert.equal(isValidStatusTransition(from, "cancelled", "admin_cancel"), true);
  }
});

test("conflict detection: in_progress -> status_conflict", () => {
  assert.equal(isValidStatusTransition("in_progress", "status_conflict", "conflict_detected"), true);
});

test("reopen: done -> active on member request", () => {
  assert.equal(isValidStatusTransition("done", "active", "member_reopen"), true);
});

test("conflict status is not silently overwritten by non-resolution triggers", () => {
  assert.equal(isValidStatusTransition("status_conflict", "in_progress", "member_reports_work"), false);
  assert.equal(isValidStatusTransition("status_conflict", "in_progress", "obstacle_resolved"), false);
});

test("rejects transitions with no matching rule", () => {
  assert.equal(isValidStatusTransition("done", "blocked", "obstacle_reported"), false);
  assert.equal(isValidStatusTransition("paused", "done", "obstacle_reported"), false);
});

test("member cancel proposal is a pending action, not a direct status change", () => {
  assert.equal(canRequestPendingAction("active", "cancellation"), true);
  assert.equal(canRequestPendingAction("cancelled", "cancellation"), false);
  assert.equal(canRequestPendingAction("done", "cancellation"), false);
});
