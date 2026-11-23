export type Role = "member" | "admin";
export type MembershipStatus = "pending" | "active" | "inactive" | "transferred" | "resigned" | "removed";

export interface PermissionActor {
  memberId: string;
  role: Role;
  membershipStatus: MembershipStatus;
}

export interface TaskPermissionSubject {
  createdByMemberId: string;
  assigneeMemberIds: readonly string[];
  contributorMemberIds: readonly string[];
}

export type TaskAction =
  | "create"
  | "update_fields"
  | "cancel"
  | "propose_cancellation"
  | "approve_cancellation"
  | "claim"
  | "update_progress"
  | "propose_handoff"
  | "reopen"
  | "confirm_candidate";

export type MemberAction = "add" | "deactivate" | "transfer" | "reactivate";

const ADMIN_ONLY_TASK_ACTIONS: readonly TaskAction[] = [
  "create",
  "update_fields",
  "cancel",
  "approve_cancellation",
];

const PARTICIPANT_TASK_ACTIONS: readonly TaskAction[] = [
  "propose_cancellation",
  "update_progress",
  "propose_handoff",
  "reopen",
];

function isTaskParticipant(actor: PermissionActor, subject: TaskPermissionSubject): boolean {
  return subject.assigneeMemberIds.includes(actor.memberId) || subject.contributorMemberIds.includes(actor.memberId);
}

/** MASTER_SPEC.md §6 — permission checks are deterministic; the LLM never decides authorization. */
export function canPerformTaskAction(
  action: TaskAction,
  actor: PermissionActor,
  subject: TaskPermissionSubject,
): boolean {
  if (actor.membershipStatus !== "active") return false;
  if (actor.role === "admin") return true;

  if (ADMIN_ONLY_TASK_ACTIONS.includes(action)) return false;

  if (action === "confirm_candidate") {
    return subject.createdByMemberId === actor.memberId;
  }

  // Chief-review finding: §6.1 lets any active member submit a report, and
  // reporting on an unassigned task is how a member becomes a contributor
  // in the first place — gating `update_progress` on already being a
  // participant made first-touch on an unclaimed active task impossible.
  // `claim` is the explicit action a report-processing flow performs (add
  // the reporter as a contributor) before any participant-gated action.
  if (action === "claim") {
    return true;
  }

  if (PARTICIPANT_TASK_ACTIONS.includes(action)) {
    return isTaskParticipant(actor, subject);
  }

  return false;
}

export function canPerformMemberAction(_action: MemberAction, actor: PermissionActor): boolean {
  return actor.role === "admin" && actor.membershipStatus === "active";
}

/**
 * §14/ACCEPTANCE_TESTS.md §1.1: a phone-number change relinks the member's
 * JID. Modeled as self-service (a member relinking their own number) or
 * admin-performed (on behalf of another member) — the spec names the flow
 * but not who triggers it, so both are allowed. Chief-review finding: this
 * action was missing entirely despite the schema being built for it.
 */
export function canRelinkIdentifier(actor: PermissionActor, targetMemberId: string): boolean {
  if (actor.membershipStatus !== "active") return false;
  return actor.role === "admin" || actor.memberId === targetMemberId;
}

/**
 * §15: a leave/izin declaration is self-service (a member declaring their
 * own leave) or admin-performed on behalf of another member — mirrors
 * canRelinkIdentifier's self-or-admin rule exactly.
 */
export function canSetAvailability(actor: PermissionActor, targetMemberId: string): boolean {
  if (actor.membershipStatus !== "active") return false;
  return actor.role === "admin" || actor.memberId === targetMemberId;
}

/**
 * Exporting a day's report as a file that leaves the division.
 *
 * Admin-only, unlike every other query intent, which any active member may
 * run. The others answer INTO the group, where the audience is already the
 * division; this one produces a file whose whole purpose is to be forwarded
 * outside it, carrying every member's activity and, in the leave column,
 * their stated reason for being away. Who sends that out is a decision, not
 * a lookup.
 */
export function canExportDailyReport(actor: PermissionActor): boolean {
  return actor.membershipStatus === "active" && actor.role === "admin";
}

/**
 * Creating a task, and assigning it to people, from a chat message.
 *
 * Admin-only, and for a stronger reason than the export: this is the first
 * path in the system where a model's reading of a sentence becomes a row
 * that other people are then chased about. §6.1 already says a non-admin
 * proposes rather than acts; typing an instruction into the group does not
 * change who is allowed to give it.
 */
export function canCreateTaskViaChat(actor: PermissionActor): boolean {
  return actor.membershipStatus === "active" && actor.role === "admin";
}

/**
 * Checking oneself in for overtime. Any active member, for themselves —
 * the same self-service shape as declaring one's own leave. It records
 * attendance, it does not create work or assign anyone, so it needs no
 * admin gate.
 */
export function canCheckInOvertime(actor: PermissionActor): boolean {
  return actor.membershipStatus === "active";
}

export function isEligibleForReminder(member: { membershipStatus: MembershipStatus; reportRequired: boolean }): boolean {
  return member.membershipStatus === "active" && member.reportRequired;
}
