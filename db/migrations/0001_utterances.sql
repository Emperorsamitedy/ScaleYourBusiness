CREATE TYPE "public"."utterance_intent" AS ENUM('ask', 'tell', 'correct', 'request', 'limit', 'social');--> statement-breakpoint
CREATE TYPE "public"."utterance_role" AS ENUM('owner', 'system');--> statement-breakpoint
CREATE TABLE "utterances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "utterance_role" NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"intent" "utterance_intent",
	"extracted_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"cost_eur" numeric(12, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "utterances_profile_idx" ON "utterances" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "utterances_thread_at_idx" ON "utterances" USING btree ("thread_id","at");