CREATE TYPE "public"."field_status" AS ENUM('answered', 'unknown', 'not_applicable', 'skipped', 'inferred', 'unasked');--> statement-breakpoint
CREATE TYPE "public"."profile_section" AS ENUM('identity', 'presence', 'offers', 'revenue', 'costs', 'customers', 'channels', 'marketing', 'operations', 'tooling', 'legal', 'competitors', 'goals', 'assets');--> statement-breakpoint
CREATE TABLE "field_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"section" "profile_section" NOT NULL,
	"field_key" text NOT NULL,
	"value" jsonb,
	"status" "field_status" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"source" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid
);
--> statement-breakpoint
ALTER TABLE "field_records" ADD CONSTRAINT "field_records_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_records" ADD CONSTRAINT "field_records_superseded_by_field_records_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."field_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "field_records_current_idx" ON "field_records" USING btree ("profile_id","field_key") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX "field_records_profile_section_idx" ON "field_records" USING btree ("profile_id","section");