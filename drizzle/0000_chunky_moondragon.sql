CREATE TYPE "public"."availability_kind" AS ENUM('izin', 'cuti', 'sakit', 'not_scheduled');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('pending', 'active', 'inactive', 'transferred', 'resigned', 'removed');--> statement-breakpoint
CREATE TYPE "public"."pending_action_state" AS ENUM('pending', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."pending_action_type" AS ENUM('handoff', 'cancellation', 'project_confirmation');--> statement-breakpoint
CREATE TYPE "public"."report_item_status" AS ENUM('worked_on', 'in_progress', 'testing', 'blocked', 'done', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('active', 'active_unreviewed', 'in_progress', 'blocked', 'paused', 'stale', 'status_conflict', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"audit_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_member_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_tasks" (
	"candidate_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_item_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"suggested_title" text NOT NULL,
	"matched_task_id" uuid,
	"summaries_shown_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_as_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_outages" (
	"outage_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"announced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"reporting_day" date NOT NULL,
	"source_message_id" text,
	"no_activity" boolean DEFAULT false NOT NULL,
	"pending_admin_confirmation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"summary_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"summary_day" date NOT NULL,
	"content" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_messages" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whatsapp_message_key" text NOT NULL,
	"sender_jid" text NOT NULL,
	"raw_text" text,
	"message_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_replayed" boolean DEFAULT false NOT NULL,
	"edited_from_message_id" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_invocations" (
	"invocation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"thinking_mode" boolean DEFAULT false NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"estimated_cost_usd" numeric(12, 8) NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_aliases" (
	"alias_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_availability" (
	"availability_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" "availability_kind" NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_identifiers" (
	"identifier_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"whatsapp_jid" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "members" (
	"member_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preferred_name" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"membership_status" "membership_status" DEFAULT 'pending' NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"report_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_context" (
	"context_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"pending_action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"action_type" "pending_action_type" NOT NULL,
	"state" "pending_action_state" DEFAULT 'pending' NOT NULL,
	"requested_by_member_id" uuid NOT NULL,
	"target_member_id" uuid,
	"decided_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_message_keys" (
	"whatsapp_message_key" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_aliases" (
	"alias_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"project_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_items" (
	"item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"task_id" uuid,
	"activity" text NOT NULL,
	"result" text,
	"obstacle" text,
	"status" "report_item_status" DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_revisions" (
	"revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"raw_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"job_run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sheets_sync_events" (
	"sync_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tab_name" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_assignees" (
	"task_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_contributors" (
	"task_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"first_contributed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_member_id" uuid,
	"from_status" "task_status",
	"to_status" "task_status",
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_obstacles" (
	"obstacle_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"reported_by_member_id" uuid,
	"description" text NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"project_id" uuid,
	"status" "task_status" DEFAULT 'active' NOT NULL,
	"deadline_label" text,
	"must_finish_before" timestamp with time zone,
	"latest_update" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_since" timestamp with time zone,
	"confirmation_state" text,
	"needs_reassignment" boolean DEFAULT false NOT NULL,
	"source_reference" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_summaries" (
	"summary_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" date NOT NULL,
	"provisional" boolean DEFAULT true NOT NULL,
	"content" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_member_id_members_member_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_tasks" ADD CONSTRAINT "candidate_tasks_report_item_id_report_items_item_id_fk" FOREIGN KEY ("report_item_id") REFERENCES "public"."report_items"("item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_tasks" ADD CONSTRAINT "candidate_tasks_created_by_member_id_members_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_tasks" ADD CONSTRAINT "candidate_tasks_matched_task_id_tasks_task_id_fk" FOREIGN KEY ("matched_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_tasks" ADD CONSTRAINT "candidate_tasks_resolved_as_task_id_tasks_task_id_fk" FOREIGN KEY ("resolved_as_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_aliases" ADD CONSTRAINT "member_aliases_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_availability" ADD CONSTRAINT "member_availability_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_identifiers" ADD CONSTRAINT "member_identifiers_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_context" ADD CONSTRAINT "message_context_message_id_incoming_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."incoming_messages"("message_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_requested_by_member_id_members_member_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_target_member_id_members_member_id_fk" FOREIGN KEY ("target_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_decided_by_member_id_members_member_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_aliases" ADD CONSTRAINT "project_aliases_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_member_id_members_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_revision_id_report_revisions_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."report_revisions"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_revisions" ADD CONSTRAINT "report_revisions_report_id_daily_reports_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."daily_reports"("report_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contributors" ADD CONSTRAINT "task_contributors_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contributors" ADD CONSTRAINT "task_contributors_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_member_id_members_member_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_obstacles" ADD CONSTRAINT "task_obstacles_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_obstacles" ADD CONSTRAINT "task_obstacles_reported_by_member_id_members_member_id_fk" FOREIGN KEY ("reported_by_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_member_id_members_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_reports_member_day_idx" ON "daily_reports" USING btree ("member_id","reporting_day");--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_messages_key_idx" ON "incoming_messages" USING btree ("whatsapp_message_key");--> statement-breakpoint
CREATE UNIQUE INDEX "member_identifiers_current_jid_idx" ON "member_identifiers" USING btree ("whatsapp_jid") WHERE "member_identifiers"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_actions_open_unique_idx" ON "pending_actions" USING btree ("task_id","action_type") WHERE "pending_actions"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "task_assignees_unique_idx" ON "task_assignees" USING btree ("task_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_contributors_unique_idx" ON "task_contributors" USING btree ("task_id","member_id");--> statement-breakpoint
CREATE INDEX "task_events_task_id_idx" ON "task_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_must_finish_before_idx" ON "tasks" USING btree ("must_finish_before");