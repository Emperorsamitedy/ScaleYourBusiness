CREATE TYPE "public"."question_priority" AS ENUM('core', 'important', 'deep', 'optional');--> statement-breakpoint
CREATE TABLE "bank_entity_schemas" (
	"bank_version" text NOT NULL,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"min_items" integer,
	"fields" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_questions" (
	"bank_version" text NOT NULL,
	"id" text NOT NULL,
	"question_version" integer NOT NULL,
	"section" "profile_section" NOT NULL,
	"writes_to" text NOT NULL,
	"prompt" jsonb NOT NULL,
	"help_text" jsonb,
	"input" jsonb NOT NULL,
	"condition" jsonb,
	"priority" "question_priority" NOT NULL,
	"cost" integer NOT NULL,
	"unlocks" jsonb
);
--> statement-breakpoint
CREATE TABLE "bank_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_hash" text NOT NULL,
	"question_count" integer NOT NULL,
	"vocabulary_count" integer NOT NULL,
	"entity_schema_count" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_entity_schemas" ADD CONSTRAINT "bank_entity_schemas_bank_version_bank_versions_version_fk" FOREIGN KEY ("bank_version") REFERENCES "public"."bank_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_bank_version_bank_versions_version_fk" FOREIGN KEY ("bank_version") REFERENCES "public"."bank_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_entity_schemas_pk" ON "bank_entity_schemas" USING btree ("bank_version","key");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_questions_pk" ON "bank_questions" USING btree ("bank_version","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_versions_current_idx" ON "bank_versions" USING btree ("is_current") WHERE is_current;