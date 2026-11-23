ALTER TYPE "public"."availability_kind" ADD VALUE 'telat';--> statement-breakpoint
ALTER TYPE "public"."availability_kind" ADD VALUE 'pulang_cepat';--> statement-breakpoint
ALTER TABLE "daily_reports" ADD COLUMN "overtime_start_text" text;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD COLUMN "overtime_end_text" text;