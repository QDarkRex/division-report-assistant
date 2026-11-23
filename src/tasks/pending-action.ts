import type { TaskStatus } from "./state-machine.ts";

/** Pending/transient states per MASTER_SPEC.md §7.3, modeled off the main status column. */
export const PENDING_ACTION_TYPES = ["handoff", "cancellation", "project_confirmation"] as const;
export type PendingActionType = (typeof PENDING_ACTION_TYPES)[number];

export const PENDING_ACTION_STATES = ["pending", "accepted", "rejected", "expired"] as const;
export type PendingActionState = (typeof PENDING_ACTION_STATES)[number];

/**
 * Statuses a pending action of a given type may be requested from.
 * `cancellation` from `active`/`in_progress` is directly evidenced by
 * ACCEPTANCE_TESTS.md §3.2 ("Member cancel proposal | active | member
 * request | cancellation_pending"); the remaining source statuses and the
 * `handoff` / `project_confirmation` rows are inferred from MASTER_SPEC.md
 * §6.1 ("propose handoff", "propose cancellation") and flagged here as a
 * Phase 1 assumption to confirm against real workflow examples.
 */
const REQUESTABLE_FROM: Record<PendingActionType, readonly TaskStatus[]> = {
  cancellation: ["active", "in_progress", "blocked", "paused", "status_conflict"],
  handoff: ["active", "in_progress", "blocked", "paused"],
  project_confirmation: ["active", "in_progress", "active_unreviewed"],
};

export function canRequestPendingAction(currentStatus: TaskStatus, actionType: PendingActionType): boolean {
  return REQUESTABLE_FROM[actionType].includes(currentStatus);
}
