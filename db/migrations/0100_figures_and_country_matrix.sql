CREATE TYPE "public"."figure_source" AS ENUM('measured', 'stated', 'derived', 'peer', 'official');--> statement-breakpoint
CREATE TYPE "public"."recording_regime" AS ENUM('all_party', 'single_party');--> statement-breakpoint
CREATE TABLE "country_compliance_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country" text NOT NULL,
	"op" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"actor" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "country_compliance_matrix" (
	"country" text PRIMARY KEY NOT NULL,
	"recording_regime" "recording_regime" DEFAULT 'all_party' NOT NULL,
	"criminal_penalty" boolean DEFAULT true NOT NULL,
	"ai_disclosure_required" boolean DEFAULT true NOT NULL,
	"outbound_consent_required" boolean DEFAULT true NOT NULL,
	"legal_signoff_date" date,
	"legal_signoff_reference" text,
	"blocked" boolean DEFAULT true NOT NULL,
	"outbound_blocked" boolean DEFAULT true NOT NULL,
	"execution_halted" boolean DEFAULT false NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "country_compliance_matrix_iso" CHECK ("country_compliance_matrix"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "country_compliance_matrix_signoff" CHECK (("country_compliance_matrix"."blocked" and "country_compliance_matrix"."outbound_blocked") or ("country_compliance_matrix"."legal_signoff_date" is not null and coalesce(trim("country_compliance_matrix"."legal_signoff_reference"), '') <> '')),
	CONSTRAINT "country_compliance_matrix_inbound_first" CHECK ("country_compliance_matrix"."outbound_blocked" or not "country_compliance_matrix"."blocked"),
	CONSTRAINT "country_compliance_matrix_disclosure" CHECK ("country_compliance_matrix"."ai_disclosure_required")
);
--> statement-breakpoint
CREATE TABLE "figures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" numeric NOT NULL,
	"currency" text,
	"source" "figure_source" NOT NULL,
	"source_detail" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"confidence" text NOT NULL,
	"depends_on" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"method" text,
	"modelled" boolean DEFAULT false NOT NULL,
	"cross_check_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "figures_grade" CHECK ("figures"."confidence" in ('A', 'B', 'C', 'D')),
	CONSTRAINT "figures_money_is_minor_units" CHECK ("figures"."currency" is null or ("figures"."currency" ~ '^[A-Z]{3}$' and "figures"."value" = trunc("figures"."value"))),
	CONSTRAINT "figures_stated_is_d" CHECK ("figures"."source" <> 'stated' or "figures"."confidence" = 'D'),
	CONSTRAINT "figures_reference_is_c" CHECK ("figures"."source" not in ('peer', 'official') or "figures"."confidence" = 'C'),
	CONSTRAINT "figures_measured_grade" CHECK ("figures"."source" <> 'measured' or ("figures"."confidence" = 'A') = ("figures"."cross_check_id" is not null)),
	CONSTRAINT "figures_measured_is_a_or_b" CHECK ("figures"."source" <> 'measured' or "figures"."confidence" in ('A', 'B')),
	CONSTRAINT "figures_derived_names_inputs" CHECK (("figures"."source" = 'derived') = (cardinality("figures"."depends_on") > 0) and ("figures"."source" <> 'derived' or "figures"."method" is not null))
);
--> statement-breakpoint
ALTER TABLE "figures" ADD CONSTRAINT "figures_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "country_compliance_changes_country_idx" ON "country_compliance_changes" USING btree ("country","at");--> statement-breakpoint
CREATE INDEX "figures_profile_key_idx" ON "figures" USING btree ("profile_id","key","captured_at");