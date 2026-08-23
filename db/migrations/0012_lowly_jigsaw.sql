CREATE TYPE "public"."finding_kind" AS ENUM('gap', 'contradiction', 'implausible', 'stale');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('blocking', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TABLE "validation_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" "finding_kind" NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"field_keys" jsonb NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"message" jsonb NOT NULL,
	"resolution" jsonb,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "validation_findings_open_idx" ON "validation_findings" USING btree ("profile_id","rule_id") WHERE resolution IS NULL;--> statement-breakpoint
CREATE INDEX "validation_findings_profile_idx" ON "validation_findings" USING btree ("profile_id");