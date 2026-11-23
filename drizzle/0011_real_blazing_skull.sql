CREATE TYPE "public"."report_kind" AS ENUM('regular', 'overtime');--> statement-breakpoint
DROP INDEX "daily_reports_member_day_idx";--> statement-breakpoint
ALTER TABLE "daily_reports" ADD COLUMN "kind" "report_kind" DEFAULT 'regular' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_reports_member_day_kind_idx" ON "daily_reports" USING btree ("member_id","reporting_day","kind");