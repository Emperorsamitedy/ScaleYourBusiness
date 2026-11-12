CREATE TYPE "public"."standing_rule_action" AS ENUM('allow', 'forbid', 'require_approval');--> statement-breakpoint
ALTER TYPE "public"."ladder_event_kind" ADD VALUE 'auto_demotion';--> statement-breakpoint
ALTER TYPE "public"."ladder_event_kind" ADD VALUE 'connector_demotion';--> statement-breakpoint
CREATE TABLE "capability_caps" (
	"profile_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"currency" text NOT NULL,
	"max_daily_spend_delta_minor" bigint,
	"max_single_action_minor" bigint NOT NULL,
	"max_actions_per_day" integer NOT NULL,
	"blackout_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_approval_above_minor" bigint,
	"never_touch" text[] DEFAULT '{}'::text[] NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_caps_currency" CHECK ("capability_caps"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "capability_caps_non_negative" CHECK ("capability_caps"."max_single_action_minor" >= 0 and "capability_caps"."max_actions_per_day" >= 0 and coalesce("capability_caps"."max_daily_spend_delta_minor", 0) >= 0 and coalesce("capability_caps"."require_approval_above_minor", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "owner_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "promotion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"to_station" integer NOT NULL,
	"eligibility" jsonb NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "promotion_requests_station" CHECK ("promotion_requests"."to_station" = 4)
);
--> statement-breakpoint
CREATE TABLE "standing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"condition" jsonb NOT NULL,
	"action" "standing_rule_action" NOT NULL,
	"words" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "standing_rules_expiry" CHECK ("standing_rules"."expires_at" > "standing_rules"."created_at")
);
--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "shadow_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "capability_caps" ADD CONSTRAINT "capability_caps_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_notices" ADD CONSTRAINT "owner_notices_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_requests" ADD CONSTRAINT "promotion_requests_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capability_caps_pk" ON "capability_caps" USING btree ("profile_id","capability");--> statement-breakpoint
CREATE INDEX "owner_notices_profile_idx" ON "owner_notices" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_requests_one_open" ON "promotion_requests" USING btree ("profile_id","capability") WHERE "promotion_requests"."confirmed_at" is null and "promotion_requests"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "standing_rules_profile_idx" ON "standing_rules" USING btree ("profile_id","expires_at");