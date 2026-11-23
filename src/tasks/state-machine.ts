/**
 * Main task statuses, per MASTER_SPEC.md §7.2, MINUS `overdue`. Overdue is
 * derived at read time from `classifyDeadlineStage(now, mustFinishBefore)`
 * (./deadline.ts) rather than stored: persisting it as a status would fight
 * this transition table (a task can be simultaneously "overdue" and
 * "blocked", and the deadline clock ticks independently of any trigger
 * here). Chief-review finding, Phase 1.
 *
 * Pending/transient states (§7.3) are intentionally NOT part of this enum —
 * the spec is explicit ("do not overload a single status column, model
 * pending actions separately"), so they live solely in the `pending_actions`
 * table (see ./pending-action.ts) — not duplicated onto the task row.
 */
export const TASK_STATUSES = [
  "active",
  "active_unreviewed",
  "in_progress",
  "blocked",
  "paused",
  "stale",
  "status_conflict",
  "done",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type StatusTransitionTrigger =
  | "member_reports_work"
  | "member_marks_done"
  | "obstacle_reported"
  | "obstacle_resolved"
  | "stale_detected"
  | "resume_from_stale"
  | "admin_pause"
  | "resume_from_pause"
  | "admin_cancel"
  | "conflict_detected"
  | "admin_resolve_conflict"
  | "member_reopen";

interface TransitionRule {
  trigger: StatusTransitionTrigger;
  from: readonly TaskStatus[] | "any";
  to: TaskStatus;
}

/**
 * Transition table sourced directly from ACCEPTANCE_TESTS.md §3.2, plus
 * inferred rules needed to make the graph usable (the acceptance table only
 * covers happy-path edges) — flagged as Phase 1 assumptions pending
 * confirmation:
 *  - `member_marks_done` accepts `blocked`/`stale` sources too: the
 *    original table only allowed completion from `in_progress`, which made
 *    a blocked or stale task permanently uncompletable.
 *  - `admin_pause` / `resume_from_pause`: `paused` was in the status enum
 *    (§7.2) with no transition ever producing or leaving it.
 *  - `resume_from_stale`: `stale` was a dead end with no way back to work.
 *  - `admin_resolve_conflict`: §3.4 states status_conflict must not be
 *    silently overwritten and stays until an admin resolves it, but no
 *    explicit resolution trigger/target is given. Modeled as admin-only,
 *    resolving back to in_progress (the only state conflict can arise from).
 */
const TRANSITIONS: readonly TransitionRule[] = [
  { trigger: "member_reports_work", from: ["active", "active_unreviewed"], to: "in_progress" },
  { trigger: "member_marks_done", from: ["active", "in_progress", "blocked", "stale"], to: "done" },
  { trigger: "obstacle_reported", from: ["in_progress"], to: "blocked" },
  { trigger: "obstacle_resolved", from: ["blocked"], to: "in_progress" },
  { trigger: "stale_detected", from: ["in_progress"], to: "stale" },
  { trigger: "resume_from_stale", from: ["stale"], to: "in_progress" },
  { trigger: "admin_pause", from: ["active", "in_progress", "blocked"], to: "paused" },
  { trigger: "resume_from_pause", from: ["paused"], to: "in_progress" },
  { trigger: "admin_cancel", from: "any", to: "cancelled" },
  { trigger: "conflict_detected", from: ["in_progress"], to: "status_conflict" },
  { trigger: "admin_resolve_conflict", from: ["status_conflict"], to: "in_progress" },
  { trigger: "member_reopen", from: ["done"], to: "active" },
];

export function isValidStatusTransition(from: TaskStatus, to: TaskStatus, trigger: StatusTransitionTrigger): boolean {
  return TRANSITIONS.some(
    (rule) => rule.trigger === trigger && rule.to === to && (rule.from === "any" || rule.from.includes(from)),
  );
}

export function allowedTransitionsFrom(from: TaskStatus): readonly TransitionRule[] {
  return TRANSITIONS.filter((rule) => rule.from === "any" || rule.from.includes(from));
}
