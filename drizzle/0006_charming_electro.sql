CREATE TYPE "public"."member_level" AS ENUM('senior', 'staff', 'magang');--> statement-breakpoint
ALTER TYPE "public"."availability_kind" ADD VALUE 'masuk';--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "level" "member_level" DEFAULT 'magang' NOT NULL;