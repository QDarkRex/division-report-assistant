CREATE TABLE "pending_confirmations" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"intent" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD CONSTRAINT "pending_confirmations_member_id_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("member_id") ON DELETE no action ON UPDATE no action;