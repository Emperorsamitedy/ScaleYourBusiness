CREATE TYPE "public"."price_tier" AS ENUM('watch', 'act', 'autonomous', 'extra_business', 'full_diagnosis', 'partner_starter', 'partner_practice', 'partner_network');--> statement-breakpoint
CREATE TYPE "public"."quota_metric" AS ENUM('llm_tokens', 'video_renders', 'connector_calls');--> statement-breakpoint
CREATE TABLE "case_studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"nace" text NOT NULL,
	"segment" text NOT NULL,
	"local_amount_minor" bigint NOT NULL,
	"eur_equivalent_minor" bigint,
	"fx_rate_to_eur" text,
	"fx_rate_date" date,
	"fx_source" text,
	"mechanism" text NOT NULL,
	"ledger_entry_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_studies_mechanism" CHECK (length(trim("case_studies"."mechanism")) >= 20),
	CONSTRAINT "case_studies_backed" CHECK (cardinality("case_studies"."ledger_entry_ids") > 0),
	CONSTRAINT "case_studies_fx" CHECK (("case_studies"."eur_equivalent_minor" is null) = ("case_studies"."fx_rate_to_eur" is null) and ("case_studies"."fx_rate_to_eur" is null) = ("case_studies"."fx_rate_date" is null))
);
--> statement-breakpoint
CREATE TABLE "country_launches" (
	"country" text PRIMARY KEY NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" text NOT NULL,
	"qualifying_cohort" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"minor_units" integer NOT NULL,
	"rounding_increment_minor" integer NOT NULL,
	"price_rounding_increment_minor" integer NOT NULL,
	"symbol" text NOT NULL,
	"symbol_position" text NOT NULL,
	"thousands_sep" text NOT NULL,
	"decimal_sep" text NOT NULL,
	"processor_amount_divisor_minor" integer NOT NULL,
	"processor_notes" text,
	CONSTRAINT "currencies_code" CHECK ("currencies"."code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "currencies_steps" CHECK ("currencies"."rounding_increment_minor" > 0 and "currencies"."price_rounding_increment_minor" > 0 and "currencies"."processor_amount_divisor_minor" > 0),
	CONSTRAINT "currencies_position" CHECK ("currencies"."symbol_position" in ('before', 'after'))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"currency" text NOT NULL,
	"date" date NOT NULL,
	"per_eur" text NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate" CHECK ("fx_rates"."per_eur" ~ '^[0-9]{1,12}(\.[0-9]{1,10})?$')
);
--> statement-breakpoint
CREATE TABLE "price_book" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier" "price_tier" NOT NULL,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"list_amount_minor" bigint NOT NULL,
	"ppp_index" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "price_book_amount" CHECK ("price_book"."list_amount_minor" > 0),
	CONSTRAINT "price_book_window" CHECK ("price_book"."effective_to" is null or "price_book"."effective_to" > "price_book"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "price_book_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_book_id" uuid NOT NULL,
	"change" jsonb NOT NULL,
	"reviewed_by" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"tier" "price_tier" NOT NULL,
	"billing_country" text NOT NULL,
	"vat_country" text NOT NULL,
	"currency" text NOT NULL,
	"price_amount_minor" bigint NOT NULL,
	"price_book_id" uuid NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_quotas" (
	"tier" "price_tier" NOT NULL,
	"metric" "quota_metric" NOT NULL,
	"monthly_soft" bigint NOT NULL,
	"monthly_hard" bigint NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "usage_quotas_order" CHECK (0 <= "usage_quotas"."monthly_soft" and "usage_quotas"."monthly_soft" <= "usage_quotas"."monthly_hard")
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "reporting_eur_minor" bigint;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "reporting_fx_rate" text;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "reporting_fx_date" date;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "reporting_fx_source" text;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_pk" ON "fx_rates" USING btree ("currency","date");--> statement-breakpoint
CREATE INDEX "price_book_lookup" ON "price_book" USING btree ("tier","country","effective_from");--> statement-breakpoint
CREATE INDEX "subscriptions_profile_idx" ON "subscriptions" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_quotas_pk" ON "usage_quotas" USING btree ("tier","metric");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reporting_fx" CHECK (("ledger_entries"."reporting_fx_rate" is null) = ("ledger_entries"."reporting_fx_date" is null) and ("ledger_entries"."reporting_fx_date" is null) = ("ledger_entries"."reporting_fx_source" is null));