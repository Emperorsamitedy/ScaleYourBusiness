CREATE TYPE "public"."content_kind" AS ENUM('post', 'email', 'shot_list', 'video');--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"goal_id" uuid,
	"kind" "content_kind" NOT NULL,
	"channel_label" text NOT NULL,
	"scheduled_for" date,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"media_path" text,
	"disclosure" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_items_profile_idx" ON "content_items" USING btree ("profile_id","scheduled_for");