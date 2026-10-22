CREATE TYPE "public"."assistant_change_status" AS ENUM('asked', 'prepared', 'applied', 'queued', 'stale', 'superseded', 'link_only');--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'assistant_change';--> statement-breakpoint
CREATE TABLE "assistant_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"owner_utterance_id" uuid NOT NULL,
	"reply_utterance_id" uuid,
	"kind" text NOT NULL,
	"status" "assistant_change_status" NOT NULL,
	"summary" text NOT NULL,
	"current_text" text,
	"proposed_text" text,
	"link" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"basis" text,
	"result_text" text,
	"result_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assistant_changes" ADD CONSTRAINT "assistant_changes_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_changes_profile_idx" ON "assistant_changes" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_changes_reply_idx" ON "assistant_changes" USING btree ("reply_utterance_id");