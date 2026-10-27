CREATE TYPE "public"."footage_clip_status" AS ENUM('issued', 'uploaded', 'used', 'released');--> statement-breakpoint
CREATE TYPE "public"."footage_render_status" AS ENUM('queued', 'rendering', 'rendered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_generation_status" AS ENUM('generating', 'generated', 'failed');--> statement-breakpoint
CREATE TABLE "footage_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"status" "footage_clip_status" DEFAULT 'issued' NOT NULL,
	"store" text NOT NULL,
	"pathname" text NOT NULL,
	"url" text,
	"content_type" text NOT NULL,
	"declared_bytes" integer NOT NULL,
	"bytes" integer,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "footage_clips_uploaded_has_object" CHECK ("footage_clips"."status" = 'issued' OR ("footage_clips"."url" IS NOT NULL AND "footage_clips"."bytes" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "footage_renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"status" "footage_render_status" DEFAULT 'queued' NOT NULL,
	"clip_ids" jsonb NOT NULL,
	"on_screen" text,
	"caption" text,
	"scheduled_for" date,
	"attempts" integer DEFAULT 0 NOT NULL,
	"note" text,
	"result_item_id" uuid,
	"metrics" jsonb,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "footage_renders_attempt_cap" CHECK ("footage_renders"."attempts" >= 0 AND "footage_renders"."attempts" <= 3),
	CONSTRAINT "footage_renders_failed_says_why" CHECK ("footage_renders"."status" <> 'failed' OR "footage_renders"."note" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "media_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"target_item_id" uuid NOT NULL,
	"result_item_id" uuid,
	"media" text NOT NULL,
	"provider" text NOT NULL,
	"status" "media_generation_status" DEFAULT 'generating' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"estimate_minor" integer NOT NULL,
	"cost_minor" integer,
	"currency" text NOT NULL,
	"prompt_sha256" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "media_generations_media" CHECK ("media_generations"."media" IN ('image', 'video')),
	CONSTRAINT "media_generations_attempt_cap" CHECK ("media_generations"."attempts" >= 0 AND "media_generations"."attempts" <= 2),
	CONSTRAINT "media_generations_money" CHECK ("media_generations"."estimate_minor" >= 0 AND ("media_generations"."cost_minor" IS NULL OR "media_generations"."cost_minor" >= 0) AND "media_generations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "media_generations_settled_cost" CHECK ("media_generations"."status" = 'generating' OR "media_generations"."cost_minor" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "footage_clips" ADD CONSTRAINT "footage_clips_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_clips" ADD CONSTRAINT "footage_clips_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_renders" ADD CONSTRAINT "footage_renders_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_renders" ADD CONSTRAINT "footage_renders_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_renders" ADD CONSTRAINT "footage_renders_result_item_id_content_items_id_fk" FOREIGN KEY ("result_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_renders" ADD CONSTRAINT "footage_renders_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_target_item_id_content_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_result_item_id_content_items_id_fk" FOREIGN KEY ("result_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "footage_clips_item_idx" ON "footage_clips" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "footage_clips_pathname_uq" ON "footage_clips" USING btree ("pathname");--> statement-breakpoint
CREATE INDEX "footage_renders_item_idx" ON "footage_renders" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "footage_renders_one_live_uq" ON "footage_renders" USING btree ("item_id") WHERE "footage_renders"."status" IN ('queued', 'rendering');--> statement-breakpoint
CREATE UNIQUE INDEX "media_generations_proposal_uq" ON "media_generations" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "media_generations_account_idx" ON "media_generations" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "media_generations_target_idx" ON "media_generations" USING btree ("target_item_id");