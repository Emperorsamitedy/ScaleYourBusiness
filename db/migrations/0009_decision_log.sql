CREATE TYPE "public"."decision_actor" AS ENUM('system', 'owner');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('proposal', 'approval', 'rejection', 'execution', 'measurement', 'profile_change');--> statement-breakpoint
CREATE TABLE "decision_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "decision_actor" NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"ref_id" text NOT NULL,
	"payload_hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "decision_log_profile_at_idx" ON "decision_log" USING btree ("profile_id","at");