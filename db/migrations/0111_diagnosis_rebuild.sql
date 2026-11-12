CREATE TYPE "public"."leak_status" AS ENUM('open', 'in_progress', 'fixed_and_verified', 'accepted');--> statement-breakpoint
CREATE TABLE "leak_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leak_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"by" uuid,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"report_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"status" "leak_status" DEFAULT 'open' NOT NULL,
	"currency" text,
	"low_minor" bigint,
	"high_minor" bigint,
	"grade" text NOT NULL,
	"verified_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaks_verified_needs_entry" CHECK (("leaks"."status" = 'fixed_and_verified') = ("leaks"."verified_entry_id" is not null)),
	CONSTRAINT "leaks_grade" CHECK ("leaks"."grade" in ('A', 'B', 'C', 'D'))
);
--> statement-breakpoint
ALTER TABLE "diagnosis_reports" ADD COLUMN "diagnosis_grade" text;--> statement-breakpoint
ALTER TABLE "diagnosis_reports" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "diagnosis_reports" ADD COLUMN "diff" jsonb;--> statement-breakpoint
ALTER TABLE "diagnosis_reports" ADD COLUMN "priced_gaps" jsonb;--> statement-breakpoint
ALTER TABLE "leak_events" ADD CONSTRAINT "leak_events_leak_id_leaks_id_fk" FOREIGN KEY ("leak_id") REFERENCES "public"."leaks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaks" ADD CONSTRAINT "leaks_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leaks_profile_key" ON "leaks" USING btree ("profile_id","key");