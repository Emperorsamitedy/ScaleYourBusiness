CREATE TYPE "public"."alert_review_outcome" AS ENUM('reviewed', 'unusable', 'skipped_cost_cap');--> statement-breakpoint
CREATE TABLE "alert_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "alert_review_outcome" NOT NULL,
	"case_file" jsonb NOT NULL,
	"case_hash" text NOT NULL,
	"review" jsonb,
	"rejected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_eur" numeric DEFAULT '0' NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalation_reason" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alert_reviews" ADD CONSTRAINT "alert_reviews_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_reviews_profile_goal_idx" ON "alert_reviews" USING btree ("profile_id","goal_id","created_at");