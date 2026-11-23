import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle schema for the `whatsapp_division` database, covering the data
 * model listed in docs/division-report-assistant/MASTER_SPEC.md §17. Columns
 * beyond what the spec explicitly names are a reasonable minimum inferred
 * from the surrounding section — flagged in comments where the spec gives
 * no explicit column list.
 */

export const membershipStatusEnum = pgEnum("membership_status", [
  "pending",
  "active",
  "inactive",
  "transferred",
  "resigned",
  "removed",
]);

export const memberRoleEnum = pgEnum("member_role", ["member", "admin"]);

// Chief-review fix: "overdue" removed — it's derived from deadline.ts's
// classifyDeadlineStage(), not persisted (see src/tasks/state-machine.ts's
// TASK_STATUSES for the full rationale). Must stay in sync with that array.
export const taskStatusEnum = pgEnum("task_status", [
  "active",
  "active_unreviewed",
  "in_progress",
  "blocked",
  "paused",
  "stale",
  "status_conflict",
  "done",
  "cancelled",
]);

export const pendingActionTypeEnum = pgEnum("pending_action_type", [
  "handoff",
  "cancellation",
  "project_confirmation",
]);

export const pendingActionStateEnum = pgEnum("pending_action_state", ["pending", "accepted", "rejected", "expired"]);

export const reportItemStatusEnum = pgEnum("report_item_status", [
  "worked_on",
  "in_progress",
  "testing",
  "blocked",
  "done",
  "unknown",
]);

export const availabilityKindEnum = pgEnum("availability_kind", ["izin", "cuti", "sakit", "not_scheduled", "masuk", "telat", "pulang_cepat"]);

/**
 * The division's own three tiers, distinct from `role` (which is this
 * bot's permission level, member vs admin). Owner, 2026-08-29: senior
 * staff are Affan/Gunawan/Fikri, staff are six named people, and everyone
 * else is magang.
 *
 * It earns a column because Saturday attendance depends on it: only
 * magang are required in on Saturdays, so for everyone else a Saturday
 * with no report means "not in", not "has not reported yet".
 */
export const memberLevelEnum = pgEnum("member_level", ["senior", "staff", "magang"]);

/**
 * A daily report is either the ordinary end-of-day report or an overtime
 * (lembur) one. They are genuinely different reports, not revisions of each
 * other — a member can work a normal day AND stay for overtime, and each
 * gets its own report for the same day. Kept on daily_reports rather than
 * in a parallel table so revisions, item extraction, project matching and
 * redaction all keep working unchanged.
 */
export const reportKindEnum = pgEnum("report_kind", ["regular", "overtime"]);

/** MASTER_SPEC.md §10.6's 11 obstacle categories. */
export const obstacleCategoryEnum = pgEnum("obstacle_category", [
  "none",
  "waiting_material",
  "waiting_component",
  "waiting_information",
  "technical_issue",
  "software_issue",
  "hardware_issue",
  "dependency",
  "resource_unavailable",
  "needs_decision",
  "other",
]);

// --- Members (§14) -----------------------------------------------------

export const members = pgTable("members", {
  memberId: uuid("member_id").primaryKey().defaultRandom(),
  preferredName: text("preferred_name").notNull(),
  role: memberRoleEnum("role").notNull().default("member"),
  membershipStatus: membershipStatusEnum("membership_status").notNull().default("pending"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  reportRequired: boolean("report_required").notNull().default(true),
  // Defaults to magang: the strictest reading (Saturday required) is the
  // safe one for a member nobody has classified yet — it asks for a report
  // that may not be owed, rather than silently excusing someone who is.
  level: memberLevelEnum("level").notNull().default("magang"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Private JID mapping — never exported to Sheets (§13). */
export const memberIdentifiers = pgTable(
  "member_identifiers",
  {
    identifierId: uuid("identifier_id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.memberId),
    whatsappJid: text("whatsapp_jid").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
  },
  (table) => [
    // Partial, not global: Indonesian prepaid numbers get recycled, so a
    // JID must be unique only among *current* links, not across all history
    // — otherwise a new hire who inherits an ex-member's old number can
    // never be linked. Chief-review finding, Phase 1.
    uniqueIndex("member_identifiers_current_jid_idx")
      .on(table.whatsappJid)
      .where(sql`${table.isCurrent} = true`),
  ],
);

export const memberAliases = pgTable("member_aliases", {
  aliasId: uuid("alias_id").primaryKey().defaultRandom(),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.memberId),
  alias: text("alias").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Leave/sick/izin status (§15). */
export const memberAvailability = pgTable("member_availability", {
  availabilityId: uuid("availability_id").primaryKey().defaultRandom(),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.memberId),
  kind: availabilityKindEnum("kind").notNull(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }),
  note: text("note"),
  // §14: "The status applies immediately but an admin can correct or
  // cancel it." Cancelling soft-deletes rather than removing the row —
  // same append-only rule the rest of this schema follows (members are
  // never hard-deleted, report corrections append revisions). A mistaken
  // leave declaration and its retraction are both part of the record.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByMemberId: uuid("cancelled_by_member_id").references(() => members.memberId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Projects ------------------------------------------------------------

export const projects = pgTable("projects", {
  projectId: uuid("project_id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  confirmed: boolean("confirmed").notNull().default(false),
  createdByMemberId: uuid("created_by_member_id").references(() => members.memberId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectAliases = pgTable("project_aliases", {
  aliasId: uuid("alias_id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.projectId),
  alias: text("alias").notNull(),
});

// --- Tasks (§7) ------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    taskId: uuid("task_id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    projectId: uuid("project_id").references(() => projects.projectId),
    status: taskStatusEnum("status").notNull().default("active"),
    deadlineLabel: text("deadline_label"),
    mustFinishBefore: timestamp("must_finish_before", { withTimezone: true }),
    /**
     * The day the work is meant to happen, which is NOT the deadline.
     *
     * "Besok Nisa dan Udin ke lokasi B mengerjakan centering docking" names
     * a day of work; "selesai sebelum 25 September" names a limit. Until
     * 2026-09-08 only the limit existed, so a question like "apa tugas Nisa
     * besok" had nothing to read: the closest answer was "tasks whose
     * deadline happens to fall tomorrow", which is a different thing and
     * diverges the moment a task spans more than a day.
     *
     * A plain calendar day, stored the same way reporting days are — the
     * schedule is about which working day it is, not an instant.
     */
    scheduledFor: date("scheduled_for"),
    latestUpdate: text("latest_update"),
    createdByMemberId: uuid("created_by_member_id")
      .notNull()
      .references(() => members.memberId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    staleSince: timestamp("stale_since", { withTimezone: true }),
    // §7.3's draft/candidate_task pending states don't map onto pending_actions
    // (they precede a task existing as a confirmed row at all) — this stays a
    // loosely-typed marker for that pre-confirmation lifecycle stage until a
    // service actually needs to branch on it. handoff/cancellation/
    // project_confirmation live solely in `pending_actions` below — they are
    // NOT duplicated here (a prior draft had both, which is a stale-state bug
    // waiting to happen: two sources of truth with nothing keeping them in
    // sync). Chief-review finding, Phase 1.
    confirmationState: text("confirmation_state"),
    needsReassignment: boolean("needs_reassignment").notNull().default(false),
    sourceReference: text("source_reference"),
    // Optimistic-locking column mandated by MASTER_SPEC.md §7.1. Bumped by
    // every write path in tasks/service.ts (fixed 2026-08-08, ahead of
    // building two-way Sheets sync — found via Opus design review that no
    // write path incremented this, which would have made the sync's
    // conflict check silently vacuous). Enforced as `WHERE task_id = $id
    // AND version = $sheetVersion` in sheets/tasks-import.ts's SQL update,
    // not a JS read-then-compare (that would race the live report
    // pipeline writing to the same rows all day).
    version: integer("version").notNull().default(1),
    // Admin-only free text surfaced in the Sheets TASKS tab, editable via
    // two-way sync. Deliberately separate from `latestUpdate`, which is
    // bot-owned (written by the report pipeline) — reusing it for admin
    // notes would mean the next report silently clobbers whatever an
    // admin wrote.
    adminNote: text("admin_note"),
  },
  (table) => [index("tasks_must_finish_before_idx").on(table.mustFinishBefore)],
);

export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.taskId),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.memberId),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("task_assignees_unique_idx").on(table.taskId, table.memberId)],
);

export const taskContributors = pgTable(
  "task_contributors",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.taskId),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.memberId),
    firstContributedAt: timestamp("first_contributed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("task_contributors_unique_idx").on(table.taskId, table.memberId)],
);

/** Append-only status/field-change history (§17, §18: append-only event records). */
export const taskEvents = pgTable(
  "task_events",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.taskId),
    eventType: text("event_type").notNull(),
    actorMemberId: uuid("actor_member_id").references(() => members.memberId),
    fromStatus: taskStatusEnum("from_status"),
    toStatus: taskStatusEnum("to_status"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_events_task_id_idx").on(table.taskId)],
);

export const taskObstacles = pgTable("task_obstacles", {
  obstacleId: uuid("obstacle_id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.taskId),
  reportedByMemberId: uuid("reported_by_member_id").references(() => members.memberId),
  description: text("description").notNull(),
  resolved: boolean("resolved").notNull().default(false),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Reports (§9) ------------------------------------------------------------

export const dailyReports = pgTable(
  "daily_reports",
  {
    reportId: uuid("report_id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.memberId),
    reportingDay: date("reporting_day").notNull(), // see shared/time.ts reportingDayFor
    sourceMessageId: text("source_message_id"),
    noActivity: boolean("no_activity").notNull().default(false),
    pendingAdminConfirmation: boolean("pending_admin_confirmation").notNull().default(false),
    kind: reportKindEnum("kind").notNull().default("regular"),
    // Overtime start/stop, stored as the member stated them ("17:00", "jam
    // 5 sore") rather than parsed to a structured time: the owner reads
    // these in the sheet, and turning free clock-talk into a timestamp is
    // exactly the kind of guess the LLM must not make. Only ever set on an
    // overtime report; null on a regular one.
    overtimeStartText: text("overtime_start_text"),
    overtimeEndText: text("overtime_end_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // §9.5: corrections append a report_revisions row, never a second
    // daily_reports row for the same member/day/kind — without this, a
    // duplicate report silently bypasses the revision path instead of
    // erroring. Widened to include kind on 2026-09-11 so the regular and
    // overtime reports for one member on one day are two distinct rows
    // rather than a collision.
    uniqueIndex("daily_reports_member_day_kind_idx").on(table.memberId, table.reportingDay, table.kind),
  ],
);

/** Corrections append a new revision; the original is preserved (§9.5). */
export const reportRevisions = pgTable("report_revisions", {
  revisionId: uuid("revision_id").primaryKey().defaultRandom(),
  reportId: uuid("report_id")
    .notNull()
    .references(() => dailyReports.reportId),
  revisionNumber: integer("revision_number").notNull(),
  rawText: text("raw_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ADR-0016: the registry of work streams every report item is grouped into for the weekly recap.
 * stream_id is a stable slug ("adm-box-truck"); name is what admins may rename. New streams proposed by the
 * model are active at once (origin 'llm'); archived_at hides one without losing its history.
 */
export const workStreams = pgTable("work_streams", {
  streamId: text("stream_id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(), // <= 28 chars, used in "Lainnya" and "Tanpa laporan"
  description: text("description").notNull().default(""),
  origin: text("origin").notNull().default("seed"), // seed | llm | admin
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const reportItems = pgTable("report_items", {
  itemId: uuid("item_id").primaryKey().defaultRandom(),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => reportRevisions.revisionId),
  taskId: uuid("task_id").references(() => tasks.taskId),
  // Which project this activity belongs to, when the text says so
  // unambiguously. Separate from taskId: most report items never match a
  // task (5 of 397 did), but roughly half name their project outright, and
  // grouping the division's work by project is the whole point of having
  // projects at all.
  //
  // Nullable and deliberately left NULL when uncertain. The owner
  // confirmed 2026-08-31 that "lifter" and "antenna tracker" each exist in
  // both the Alpha and Beta dockings, so text mentioning only those
  // cannot be attributed — and a wrong attribution would surface months
  // later as a project total nobody can reconcile.
  projectId: uuid("project_id").references(() => projects.projectId),
  // Set by the weekly recap (ADR-0016); null until the item's week has been recapped.
  workStreamId: text("work_stream_id").references(() => workStreams.streamId),
  activity: text("activity").notNull(),
  result: text("result"),
  obstacle: text("obstacle"),
  // Nullable, NOT defaulted to "none" — null means "not classified"
  // (historical rows before this column existed, or the model omitted
  // it), "none" means "classified as no obstacle." Collapsing these
  // would destroy the ability to tell old rows from new ones and to
  // measure whether the classifier is actually firing (Opus design
  // review, 2026-08-08).
  obstacleCategory: obstacleCategoryEnum("obstacle_category"),
  status: reportItemStatusEnum("status").notNull().default("unknown"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Candidate tasks and pending actions (§10) --------------------------

export const candidateTasks = pgTable("candidate_tasks", {
  candidateId: uuid("candidate_id").primaryKey().defaultRandom(),
  reportItemId: uuid("report_item_id")
    .notNull()
    .references(() => reportItems.itemId),
  createdByMemberId: uuid("created_by_member_id")
    .notNull()
    .references(() => members.memberId),
  suggestedTitle: text("suggested_title").notNull(),
  matchedTaskId: uuid("matched_task_id").references(() => tasks.taskId),
  summariesShownCount: integer("summaries_shown_count").notNull().default(0),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedAsTaskId: uuid("resolved_as_task_id").references(() => tasks.taskId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Handoff / cancellation / project-confirmation proposals awaiting a decision. */
export const pendingActions = pgTable(
  "pending_actions",
  {
    pendingActionId: uuid("pending_action_id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.taskId),
    actionType: pendingActionTypeEnum("action_type").notNull(),
    state: pendingActionStateEnum("state").notNull().default("pending"),
    requestedByMemberId: uuid("requested_by_member_id")
      .notNull()
      .references(() => members.memberId),
    targetMemberId: uuid("target_member_id").references(() => members.memberId), // e.g. handoff recipient
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.memberId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    // At most one *pending* proposal of a given type per task — nothing
    // stopped two concurrent cancellation proposals before this.
    uniqueIndex("pending_actions_open_unique_idx")
      .on(table.taskId, table.actionType)
      .where(sql`${table.state} = 'pending'`),
  ],
);

// --- Message ingestion (§16, §18) --------------------------------------

export const incomingMessages = pgTable(
  "incoming_messages",
  {
    messageId: uuid("message_id").primaryKey().defaultRandom(),
    whatsappMessageKey: text("whatsapp_message_key").notNull(),
    senderJid: text("sender_jid").notNull(),
    // Owner decision 2026-08-06 (SECURITY_AND_PRIVACY.md §8.4): nulled 30
    // days after receivedAt by a Phase 3 scheduled job — not permanent like
    // audit_events. The row/key/timestamps survive for dedup and audit;
    // only the message body is redacted. Not yet implemented (pg-boss isn't
    // wired until Phase 3) — this comment is the recorded decision, not a
    // claim the cleanup job exists.
    rawText: text("raw_text"),
    // WhatsApp's own timestamp on the message, distinct from receivedAt
    // (when our ingestion pipeline actually saw it) — the gap between the
    // two is how ../messages/replay.ts tells a reconnect-replayed backlog
    // message from a live one. Chief-review finding, Phase 1 follow-up.
    messageTimestamp: timestamp("message_timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // Set by the ingestion pipeline via isReplayedMessage(). A replayed
    // message is still stored (audit trail, manual reprocessing per §16)
    // but MUST NOT proceed to LLM classification or state mutation.
    isReplayed: boolean("is_replayed").notNull().default(false),
    editedFromMessageId: uuid("edited_from_message_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("incoming_messages_key_idx").on(table.whatsappMessageKey)],
);

/** Untagged messages retained as candidate context for 48h (§5.4) — does not mutate official state. */
export const messageContext = pgTable("message_context", {
  contextId: uuid("context_id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => incomingMessages.messageId),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Idempotency guard for message processing (§18: idempotent message processing). */
export const processedMessageKeys = pgTable("processed_message_keys", {
  whatsappMessageKey: text("whatsapp_message_key").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Scheduled outputs (§11) --------------------------------------------

export const dailySummaries = pgTable(
  "daily_summaries",
  {
    summaryId: uuid("summary_id").primaryKey().defaultRandom(),
    summaryDay: date("summary_day").notNull(),
    content: jsonb("content").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // pg-boss retries jobs — without this, a retried morning-summary run
  // would insert a second row for the same day. Found 2026-08-08 (Opus
  // design review) alongside the weekly_summaries equivalent below.
  (table) => [uniqueIndex("daily_summaries_summary_day_idx").on(table.summaryDay)],
);

export const weeklySummaries = pgTable(
  "weekly_summaries",
  {
    summaryId: uuid("summary_id").primaryKey().defaultRandom(),
    weekStart: date("week_start").notNull(), // the Monday
    provisional: boolean("provisional").notNull().default(true),
    content: jsonb("content").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("weekly_summaries_week_start_idx").on(table.weekStart)],
);

/** One row per (week, stream) behind the REKAP MINGGUAN tab; every number is computed by code. */
export const weeklyStreamRecaps = pgTable(
  "weekly_stream_recaps",
  {
    weekStart: date("week_start").notNull(), // the Monday
    streamId: text("stream_id")
      .notNull()
      .references(() => workStreams.streamId),
    itemCount: integer("item_count").notNull(),
    members: text("members").notNull().default(""), // "Andre 5, Fikri 3"
    bullets: jsonb("bullets").notNull().default(sql`'[]'::jsonb`), // [{ text, evidenceItemIds[] }]
    blockedCount: integer("blocked_count").notNull().default(0),
    obstacles: text("obstacles").notNull().default(""),
    prevItemCount: integer("prev_item_count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.weekStart, table.streamId] })],
);

/** The rendered Sunday message, one row per week (a retried job overwrites). */
export const weeklyRecaps = pgTable("weekly_recaps", {
  weekStart: date("week_start").primaryKey(),
  text: text("text").notNull(),
  llmOk: boolean("llm_ok").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Domain-level log of scheduled job runs, distinct from pg-boss's own internal tables. */
export const scheduledJobs = pgTable("scheduled_jobs", {
  jobRunId: uuid("job_run_id").primaryKey().defaultRandom(),
  jobName: text("job_name").notNull(),
  status: text("status").notNull(), // succeeded | failed | skipped
  detail: jsonb("detail"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// --- External sync and reliability (§13, §16, §18) ----------------------

export const sheetsSyncEvents = pgTable("sheets_sync_events", {
  syncEventId: uuid("sync_event_id").primaryKey().defaultRandom(),
  tabName: text("tab_name").notNull(),
  direction: text("direction").notNull(), // export | import
  status: text("status").notNull(), // succeeded | failed | conflict
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What the TASKS tab was last written with, one row per task.
 *
 * Without it the import cannot tell "the sheet is stale because the BOT
 * moved this task" from "a human edited this row" — it could only diff the
 * sheet against current DB truth, and those two cases look identical.
 * Measured 2026-09-01: 259 logged conflicts and 8 WhatsApp notices telling
 * the division their sheet edits were rejected, when nobody had edited
 * anything. A member reporting work moved a task active -> in_progress and
 * bumped its version; the sheet still held the pre-change row; the next
 * hourly import read that as a losing edit.
 *
 * Diffing against this snapshot instead makes the distinction exact: a
 * field that still equals what we exported was never touched, whatever the
 * database now says. Only a field that differs is a human edit, and only
 * then does the optimistic lock get to call it a conflict.
 *
 * Editable columns only (§18) — task_id/version/derived columns are
 * bot-owned and never imported. Written from the exported cell values
 * themselves, so it records what is literally in the sheet.
 */
export const tasksSheetSnapshot = pgTable("tasks_sheet_snapshot", {
  taskId: uuid("task_id")
    .primaryKey()
    .references(() => tasks.taskId, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  projectText: text("project_text").notNull(),
  status: text("status").notNull(),
  deadlineText: text("deadline_text").notNull(),
  scheduledText: text("scheduled_text").notNull().default(""),
  assigneeText: text("assignee_text").notNull(),
  adminNote: text("admin_note").notNull(),
  exportedAt: timestamp("exported_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One pending "did you mean this?" confirmation per member.
 *
 * Added 2026-09-12 after a member's question ("siapa yang lembur?") was
 * misclassified as a check-in and filed him as on overtime. Any intent
 * that CHANGES state is now proposed first: the parsed intent is parked
 * here, the member is asked to confirm, and only an explicit "ya" runs it.
 * A read-only query never lands here.
 *
 * memberId is the primary key — one pending at a time; a new proposal
 * replaces the old. The row is short-lived (the caller ignores anything
 * older than a few minutes) so a forgotten proposal cannot execute hours
 * later on a stray "ya".
 */
export const pendingConfirmations = pgTable("pending_confirmations", {
  memberId: uuid("member_id")
    .primaryKey()
    .references(() => members.memberId),
  /**
   * What the member is being asked about; the shape depends on `kind`.
   * 'query' (the original use, and the column default so every pre-existing
   * row stays valid): a parsed QueryIntent awaiting "ya". 'report_match':
   * {reportId, items:[{itemId, taskId, planRef, flagId}]} — report items the
   * model matched to a plan task with LOW confidence, awaiting "ya" (link
   * them) or "bukan" (leave unlinked). See queries/confirmation.ts.
   *
   * One row per member whatever the kind: a new proposal of either kind
   * replaces the old one (latest wins), so a member can only ever answer the
   * most recent question the bot asked them.
   */
  kind: text("kind").notNull().default("query"),
  intent: jsonb("intent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectionOutages = pgTable("connection_outages", {
  outageId: uuid("outage_id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  announcedAt: timestamp("announced_at", { withTimezone: true }),
});

/** Cost telemetry per LLM call (§4.5 item 10: record cost per feature). */
export const llmInvocations = pgTable("llm_invocations", {
  invocationId: uuid("invocation_id").primaryKey().defaultRandom(),
  feature: text("feature").notNull(), // message_classification | report_parsing | query_intent | ...
  model: text("model").notNull(),
  thinkingMode: boolean("thinking_mode").notNull().default(false),
  promptTokens: integer("prompt_tokens").notNull(),
  completionTokens: integer("completion_tokens").notNull(),
  // numeric, not text: a prior draft stored this as text "to avoid float
  // rounding," which instead makes SUM()-ing monthly spend for the budget
  // guard (§4) impossible without casting every row. numeric(12,8) avoids
  // float rounding AND stays aggregatable.
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 8 }).notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  // NULL = the call succeeded. The brief's §3.6.1 cost telemetry listed
  // `validation_result` as required and it was never implemented: until
  // 2026-08-10 this table only ever got a row on SUCCESS, so an
  // exhausted-repair failure left no trace anywhere (callers swallowed
  // the error with an empty catch) and its token spend went uncounted.
  // Every call now writes exactly one row, success or not.
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable audit trail for every official state change (§18). */
export const auditEvents = pgTable(
  "audit_events",
  {
    auditEventId: uuid("audit_event_id").primaryKey().defaultRandom(),
    actorMemberId: uuid("actor_member_id").references(() => members.memberId),
    entityType: text("entity_type").notNull(), // task | report | member | project | pending_action
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_entity_idx").on(table.entityType, table.entityId)],
);

// --- Plan sync (external master plan -> tasks) ------------------------------

/**
 * One row per step of an external plan spreadsheet (today: the supervisor's
 * "Aerolift Drone Mobil" Master Plan). The spreadsheet is the source of
 * truth for these tasks; this table is the bot's memory of what the plan
 * said the last time it looked, which is what makes a CHANGE detectable at
 * all — without it the sync could only overwrite, never notice.
 *
 * `plan_ref` is "<sourceKey>:<ID>" (e.g. "aerolift:3.07"); the matching
 * task carries source_reference "master-plan-<sourceKey>:<ID>".
 *
 * A step that disappears from the sheet is NOT deleted and its task is NOT
 * cancelled: `missing_since` records it, because a row removed by accident
 * and a row removed on purpose look identical to a program.
 */
export const planItems = pgTable(
  "plan_items",
  {
  /**
   * NOT the key: the supervisor reuses and renumbers IDs, so the same plan_ref
   * can belong to different tasks over time. It is unique only among rows that
   * are still in the sheet (missing_since IS NULL) — see the partial unique
   * index below. The key is the task, which is what stays when an ID moves.
   */
  planRef: text("plan_ref").notNull(),
  taskId: uuid("task_id")
    .primaryKey()
    .references(() => tasks.taskId),
  area: text("area").notNull(),
  step: text("step").notNull(),
  /** The PIC exactly as the plan wrote it ("Bagas Pratama") — resolution to a member happens at sync time. */
  picRaw: text("pic_raw"),
  priority: text("priority"),
  startDate: date("start_date"),
  deadlineDate: date("deadline_date"),
  statusText: text("status_text"),
  progressPct: integer("progress_pct"),
  dependsOn: text("depends_on"),
  output: text("output"),
  doneWhen: text("done_when"),
  risk: text("risk"),
  support: text("support"),
  note: text("note"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  missingSince: timestamp("missing_since", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("plan_items_live_plan_ref_idx").on(table.planRef).where(sql`${table.missingSince} is null`)],
);

/**
 * Append-only record of what changed in the plan, one row per changed
 * field. This is what the morning summary reads to tell the division what
 * the supervisor changed overnight.
 *
 * field: status | progress | deadline | start | pic | title | added |
 * removed | reappeared | pic_unresolved. Values are display strings, not
 * typed, because they exist to be shown.
 */
export const planItemChanges = pgTable(
  "plan_item_changes",
  {
    changeId: uuid("change_id").primaryKey().defaultRandom(),
    planRef: text("plan_ref").notNull(),
    taskId: uuid("task_id").references(() => tasks.taskId),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("plan_item_changes_detected_at_idx").on(table.detectedAt)],
);

/**
 * A report item that contradicts or touches a plan task, held for a human
 * to look at (e.g. a report says "selesai" for a step the plan still shows
 * as Berjalan). Reports never change a plan task's status — the plan does —
 * so a disagreement is surfaced here instead of being applied. Schema only
 * for now; written and resolved by the report pipeline's later work.
 */
export const reportItemFlags = pgTable(
  "report_item_flags",
  {
    flagId: uuid("flag_id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => reportItems.itemId),
    reportId: uuid("report_id")
      .notNull()
      .references(() => dailyReports.reportId),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.memberId),
    taskId: uuid("task_id").references(() => tasks.taskId),
    kind: text("kind").notNull(),
    detail: jsonb("detail"),
    state: text("state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [index("report_item_flags_state_created_idx").on(table.state, table.createdAt)],
);
