CREATE TABLE "tasks_sheet_snapshot" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"project_text" text NOT NULL,
	"status" text NOT NULL,
	"deadline_text" text NOT NULL,
	"assignee_text" text NOT NULL,
	"admin_note" text NOT NULL,
	"exported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks_sheet_snapshot" ADD CONSTRAINT "tasks_sheet_snapshot_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE cascade ON UPDATE no action;