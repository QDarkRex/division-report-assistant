CREATE TABLE "plan_item_changes" (
	"change_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_ref" text NOT NULL,
	"task_id" uuid,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"plan_ref" text PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"area" text NOT NULL,
	"step" text NOT NULL,
	"pic_raw" text,
	"priority" text,
	"start_date" date,
	"deadline_date" date,
	"status_text" text,
	"progress_pct" integer,
	"depends_on" text,
	"output" text,
	"done_when" text,
	"risk" text,
	"support" text,
	"note" text,
	"last_seen_at" timestamp with time zone NOT NULL,
	"missing_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_items_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "report_item_flags" (
	"flag_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"task_id" uuid,
	"kind" text NOT NULL,
	"detail" jsonb,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "plan_item_changes" ADD CONSTRAINT "plan_item_changes_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_item_flags" ADD CONSTRAINT "report_item_flags_item_id_report_items_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."report_items"("item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_item_flags" ADD CONSTRAINT "report_item_flags_report_id_daily_reports_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."daily_reports"("report_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_item_flags" ADD CONSTRAINT "report_item_flags_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_item_flags" ADD CONSTRAINT "report_item_flags_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_item_changes_detected_at_idx" ON "plan_item_changes" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "report_item_flags_state_created_idx" ON "report_item_flags" USING btree ("state","created_at");