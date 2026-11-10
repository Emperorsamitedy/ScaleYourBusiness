CREATE TYPE "public"."ledger_verdict" AS ENUM('verified_gain', 'no_effect', 'loss', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."plan_capability" AS ENUM('meta_ads', 'google_ads', 'tiktok_ads', 'tiktok_post', 'site_copy', 'price_change', 'email_campaign', 'winback', 'reorder', 'purchase_order', 'bundle', 'hours_change', 'chat_answer', 'meta_post', 'review_reply', 'fixture');--> statement-breakpoint
CREATE TYPE "public"."plan_design" AS ENUM('holdout_geo', 'holdout_audience', 'ab_split', 'switchback', 'matched_period', 'pre_post_adjusted', 'unmeasurable');--> statement-breakpoint
CREATE TYPE "public"."plan_metric" AS ENUM('revenue', 'gross_profit', 'orders', 'bookings', 'leads', 'cost', 'cash_days');--> statement-breakpoint
CREATE TYPE "public"."plan_opened_by" AS ENUM('agent', 'owner', 'partner');--> statement-breakpoint
CREATE TABLE "ledger_chain_heads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"head_seq" bigint,
	"head_hash" text,
	"entries" integer NOT NULL,
	"external_ref" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_chain_heads_day_unique" UNIQUE("day")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint NOT NULL,
	"plan_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"verdict" "ledger_verdict" NOT NULL,
	"currency" text NOT NULL,
	"observed_effect_minor" bigint,
	"observed_low_minor" bigint,
	"observed_high_minor" bigint,
	"net_minor" bigint,
	"forecast_error_minor" bigint,
	"method_notes" text NOT NULL,
	"corrects_entry_id" uuid,
	"prev_hash" text,
	"entry_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ledger_entries_currency" CHECK ("ledger_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledger_entries_observed" CHECK (("ledger_entries"."observed_effect_minor" is null) = ("ledger_entries"."net_minor" is null) and ("ledger_entries"."observed_effect_minor" is null) = ("ledger_entries"."forecast_error_minor" is null)),
	CONSTRAINT "ledger_entries_scored_verdicts" CHECK ("ledger_entries"."verdict" = 'inconclusive' or "ledger_entries"."observed_effect_minor" is not null)
);
--> statement-breakpoint
CREATE TABLE "ledger_tamper_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"op" text NOT NULL,
	"attempted" jsonb,
	"db_user" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurement_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"proposal_id" uuid,
	"capability" "plan_capability" NOT NULL,
	"provider" text NOT NULL,
	"action_summary" text NOT NULL,
	"hypothesis" text NOT NULL,
	"primary_metric" "plan_metric" NOT NULL,
	"currency" text NOT NULL,
	"expected_effect_minor" bigint NOT NULL,
	"expected_low_minor" bigint NOT NULL,
	"expected_high_minor" bigint NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"design" "plan_design" NOT NULL,
	"control_definition" jsonb,
	"downgrade_reason" text,
	"confidence_grade" text NOT NULL,
	"cost_minor" bigint DEFAULT 0 NOT NULL,
	"reversible" boolean NOT NULL,
	"rollback_token" text,
	"opened_by" "plan_opened_by" NOT NULL,
	"ladder_station_at_open" integer NOT NULL,
	"shadow" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "measurement_plans_grade" CHECK ("measurement_plans"."confidence_grade" in ('A', 'B', 'C', 'D')),
	CONSTRAINT "measurement_plans_currency" CHECK ("measurement_plans"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "measurement_plans_range" CHECK ("measurement_plans"."expected_low_minor" <= "measurement_plans"."expected_effect_minor" and "measurement_plans"."expected_effect_minor" <= "measurement_plans"."expected_high_minor"),
	CONSTRAINT "measurement_plans_window" CHECK ("measurement_plans"."window_end" > "measurement_plans"."window_start"),
	CONSTRAINT "measurement_plans_control" CHECK (("measurement_plans"."design" = 'unmeasurable') = ("measurement_plans"."control_definition" is null)),
	CONSTRAINT "measurement_plans_pre_post_caps_c" CHECK ("measurement_plans"."design" <> 'pre_post_adjusted' or "measurement_plans"."confidence_grade" in ('C', 'D')),
	CONSTRAINT "measurement_plans_rollback" CHECK ("measurement_plans"."reversible" or "measurement_plans"."rollback_token" is null),
	CONSTRAINT "measurement_plans_station" CHECK ("measurement_plans"."ladder_station_at_open" between 1 and 4),
	CONSTRAINT "measurement_plans_cost" CHECK ("measurement_plans"."cost_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_plan_id_measurement_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."measurement_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_seq" ON "ledger_entries" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_hash" ON "ledger_entries" USING btree ("entry_hash");--> statement-breakpoint
CREATE INDEX "ledger_entries_profile_idx" ON "ledger_entries" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_plan_idx" ON "ledger_entries" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_close" ON "ledger_entries" USING btree ("plan_id") WHERE "ledger_entries"."corrects_entry_id" is null;--> statement-breakpoint
CREATE INDEX "measurement_plans_profile_idx" ON "measurement_plans" USING btree ("profile_id","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_plans_one_per_proposal" ON "measurement_plans" USING btree ("proposal_id") WHERE "measurement_plans"."proposal_id" is not null;