-- plan_items was keyed by plan_ref, but the supervisor reuses and renumbers sheet IDs, so one
-- plan_ref can belong to different tasks over time. The task is the identity; plan_ref is only
-- unique among rows still in the sheet (missing_since IS NULL).
-- Postgres names a primary key "<table>_pkey" unless told otherwise; 0014 did not.
ALTER TABLE "plan_items" DROP CONSTRAINT "plan_items_pkey";--> statement-breakpoint
ALTER TABLE "plan_items" DROP CONSTRAINT "plan_items_task_id_unique";--> statement-breakpoint
ALTER TABLE "plan_items" ADD PRIMARY KEY ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_items_live_plan_ref_idx" ON "plan_items" USING btree ("plan_ref") WHERE "plan_items"."missing_since" is null;
