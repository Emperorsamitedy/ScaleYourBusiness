CREATE TYPE "public"."intake_event_kind" AS ENUM('question_shown', 'first_input', 'answer_recorded', 'marked_unknown', 'skipped', 'reopened', 'reconcile_shown', 'reconcile_resolved', 'session_resumed', 'page_hidden');--> statement-breakpoint
CREATE TABLE "intake_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"question_id" text,
	"kind" "intake_event_kind" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ms_since_shown" integer,
	"meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_events_profile_at_idx" ON "intake_events" USING btree ("profile_id","at");