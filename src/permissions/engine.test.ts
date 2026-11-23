import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canPerformMemberAction,
  canPerformTaskAction,
  canRelinkIdentifier,
  canSetAvailability,
  isEligibleForReminder,
  type PermissionActor,
  type TaskPermissionSubject,
} from "./engine.ts";

const admin: PermissionActor = { memberId: "m-admin", role: "admin", membershipStatus: "active" };
const member: PermissionActor = { memberId: "m-1", role: "member", membershipStatus: "active" };
const otherMember: PermissionActor = { memberId: "m-2", role: "member", membershipStatus: "active" };
const inactiveMember: PermissionActor = { memberId: "m-3", role: "member", membershipStatus: "inactive" };

const taskAssignedToM1: TaskPermissionSubject = {
  createdByMemberId: "m-admin",
  assigneeMemberIds: ["m-1"],
  contributorMemberIds: [],
};

// ACCEPTANCE_TESTS.md §1.2
test("non-admin cannot create a task directly", () => {
  assert.equal(canPerformTaskAction("create", member, taskAssignedToM1), false);
});

test("non-admin cannot change another member's task fields (e.g. deadline)", () => {
  assert.equal(canPerformTaskAction("update_fields", otherMember, taskAssignedToM1), false);
  assert.equal(canPerformTaskAction("update_fields", member, taskAssignedToM1), false);
});

test("non-admin cannot cancel a task directly, but may propose cancellation as a participant", () => {
  assert.equal(canPerformTaskAction("cancel", member, taskAssignedToM1), false);
  assert.equal(canPerformTaskAction("propose_cancellation", member, taskAssignedToM1), true);
  assert.equal(canPerformTaskAction("propose_cancellation", otherMember, taskAssignedToM1), false);
});

test("admin can create, update, and cancel tasks", () => {
  assert.equal(canPerformTaskAction("create", admin, taskAssignedToM1), true);
  assert.equal(canPerformTaskAction("update_fields", admin, taskAssignedToM1), true);
  assert.equal(canPerformTaskAction("cancel", admin, taskAssignedToM1), true);
});

test("admin can activate/deactivate members, non-admin cannot", () => {
  assert.equal(canPerformMemberAction("deactivate", admin), true);
  assert.equal(canPerformMemberAction("reactivate", admin), true);
  assert.equal(canPerformMemberAction("deactivate", member), false);
});

test("inactive member receives no reminders", () => {
  assert.equal(isEligibleForReminder({ membershipStatus: "active", reportRequired: true }), true);
  assert.equal(isEligibleForReminder({ membershipStatus: "inactive", reportRequired: true }), false);
});

test("inactive actor cannot perform any task action, even admin role", () => {
  const inactiveAdmin: PermissionActor = { memberId: "m-4", role: "admin", membershipStatus: "inactive" };
  assert.equal(canPerformTaskAction("cancel", inactiveAdmin, taskAssignedToM1), false);
  assert.equal(canPerformTaskAction("update_progress", inactiveMember, taskAssignedToM1), false);
});

// Chief-review finding: first-touch on an unassigned/unclaimed task was
// impossible because update_progress required already being a participant.
test("any active member may claim an unassigned task; claim itself needs no prior participation", () => {
  const unclaimedTask: TaskPermissionSubject = {
    createdByMemberId: "m-admin",
    assigneeMemberIds: [],
    contributorMemberIds: [],
  };
  assert.equal(canPerformTaskAction("claim", otherMember, unclaimedTask), true);
  assert.equal(canPerformTaskAction("update_progress", otherMember, unclaimedTask), false);
});

test("a member may relink their own JID; an admin may relink anyone's", () => {
  assert.equal(canRelinkIdentifier(member, member.memberId), true);
  assert.equal(canRelinkIdentifier(member, otherMember.memberId), false);
  assert.equal(canRelinkIdentifier(admin, member.memberId), true);
});

test("only the report author can confirm their own candidate task", () => {
  const candidate: TaskPermissionSubject = {
    createdByMemberId: "m-1",
    assigneeMemberIds: [],
    contributorMemberIds: [],
  };
  assert.equal(canPerformTaskAction("confirm_candidate", member, candidate), true);
  assert.equal(canPerformTaskAction("confirm_candidate", otherMember, candidate), false);
});

test("a member may declare their own leave; only an admin may declare it for someone else", () => {
  assert.equal(canSetAvailability(member, member.memberId), true);
  assert.equal(canSetAvailability(member, otherMember.memberId), false);
  assert.equal(canSetAvailability(admin, otherMember.memberId), true);
});

test("an inactive member cannot declare leave, even their own", () => {
  assert.equal(canSetAvailability(inactiveMember, inactiveMember.memberId), false);
});
