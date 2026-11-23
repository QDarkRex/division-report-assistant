CREATE TABLE "weekly_recaps" (
	"week_start" date PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"llm_ok" boolean NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_stream_recaps" (
	"week_start" date NOT NULL,
	"stream_id" text NOT NULL,
	"item_count" integer NOT NULL,
	"members" text DEFAULT '' NOT NULL,
	"bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"obstacles" text DEFAULT '' NOT NULL,
	"prev_item_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "weekly_stream_recaps_week_start_stream_id_pk" PRIMARY KEY("week_start","stream_id")
);
--> statement-breakpoint
CREATE TABLE "work_streams" (
	"stream_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT 'seed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "report_items" ADD COLUMN "work_stream_id" text;--> statement-breakpoint
ALTER TABLE "weekly_stream_recaps" ADD CONSTRAINT "weekly_stream_recaps_stream_id_work_streams_stream_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."work_streams"("stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_work_stream_id_work_streams_stream_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("stream_id") ON DELETE no action ON UPDATE no action;