-- P6-03 (rules 33, 34): three AI video candidates per brief; the owner picks one, the others are kept as not_chosen.
CREATE TYPE "public"."media_candidate_status" AS ENUM('generating', 'ready', 'failed', 'chosen', 'not_chosen');--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'media_pick';--> statement-breakpoint
CREATE TABLE "media_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"target_item_id" uuid NOT NULL,
	"brief_id" uuid,
	"hook_index" integer,
	"ordinal" integer NOT NULL,
	"status" "media_candidate_status" DEFAULT 'generating' NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"request_id" text,
	"prompt_sha256" text NOT NULL,
	"label" text NOT NULL,
	"workload" text DEFAULT 'ai_video' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"estimate_minor" integer NOT NULL,
	"cost_minor" integer,
	"currency" text NOT NULL,
	"media_url" text,
	"pathname" text,
	"bytes" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"chosen_at" timestamp with time zone,
	"chosen_by" uuid,
	"result_item_id" uuid,
	CONSTRAINT "media_candidates_ordinal" CHECK ("media_candidates"."ordinal" BETWEEN 1 AND 3),
	CONSTRAINT "media_candidates_attempt_cap" CHECK ("media_candidates"."attempts" >= 0 AND "media_candidates"."attempts" <= 2),
	CONSTRAINT "media_candidates_money" CHECK ("media_candidates"."estimate_minor" >= 0 AND ("media_candidates"."cost_minor" IS NULL OR "media_candidates"."cost_minor" >= 0) AND "media_candidates"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "media_candidates_labelled" CHECK ("media_candidates"."label" LIKE '%AI-generated%'),
	CONSTRAINT "media_candidates_settled" CHECK ("media_candidates"."status" = 'generating' OR "media_candidates"."cost_minor" IS NOT NULL),
	CONSTRAINT "media_candidates_has_file" CHECK ("media_candidates"."status" NOT IN ('ready', 'chosen', 'not_chosen') OR "media_candidates"."media_url" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_generation_id_media_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."media_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_target_item_id_content_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_brief_id_creative_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."creative_briefs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_chosen_by_users_id_fk" FOREIGN KEY ("chosen_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_result_item_id_content_items_id_fk" FOREIGN KEY ("result_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_candidates_set_ordinal_uq" ON "media_candidates" USING btree ("generation_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "media_candidates_one_chosen_uq" ON "media_candidates" USING btree ("generation_id") WHERE "media_candidates"."status" = 'chosen';--> statement-breakpoint
CREATE INDEX "media_candidates_profile_idx" ON "media_candidates" USING btree ("profile_id","created_at");