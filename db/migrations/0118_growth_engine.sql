CREATE TABLE "asset_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_voice_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"description" text NOT NULL,
	"traits" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"edited_by_owner" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "brand_voice_profiles_status" CHECK ("brand_voice_profiles"."status" in ('draft', 'confirmed')),
	CONSTRAINT "brand_voice_profiles_words" CHECK (length(trim("brand_voice_profiles"."description")) > 0)
);
--> statement-breakpoint
CREATE TABLE "identity_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"person" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labelling_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"media_url" text NOT NULL,
	"content_item_id" uuid,
	"generation_id" uuid,
	"candidate_id" uuid,
	"method" text NOT NULL,
	"standard_version" text NOT NULL,
	"label" text NOT NULL,
	"labelled_at" timestamp with time zone NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "library_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"content_type" text NOT NULL,
	"description" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"shot_by" text NOT NULL,
	"person_appears" boolean NOT NULL,
	"identity_release_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_assets_kind" CHECK ("library_assets"."kind" in ('video', 'photo')),
	CONSTRAINT "library_assets_shot_by" CHECK (length(trim("library_assets"."shot_by")) > 0)
);
--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "evidence" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "angle" text;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "assets_required" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "assets_supplied" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "brand_voice_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "measurement_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD COLUMN "depicts_real_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "creative_brief_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_asset_id_library_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."library_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_voice_profiles" ADD CONSTRAINT "brand_voice_profiles_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_releases" ADD CONSTRAINT "identity_releases_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labelling_records" ADD CONSTRAINT "labelling_records_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_assets" ADD CONSTRAINT "library_assets_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_usages_once" ON "asset_usages" USING btree ("asset_id","content_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_voice_profiles_live" ON "brand_voice_profiles" USING btree ("profile_id") WHERE "brand_voice_profiles"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "labelling_records_url_idx" ON "labelling_records" USING btree ("media_url");--> statement-breakpoint
CREATE INDEX "labelling_records_item_idx" ON "labelling_records" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "library_assets_profile_idx" ON "library_assets" USING btree ("profile_id","created_at");--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD CONSTRAINT "creative_briefs_trigger" CHECK ("creative_briefs"."trigger" is null or "creative_briefs"."trigger" in ('margin_opportunity','slow_stock','dead_hours','seasonal_forecast','winback','peer_signal'));