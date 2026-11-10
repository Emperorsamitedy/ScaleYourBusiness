CREATE TYPE "public"."ladder_event_kind" AS ENUM('set', 'stop', 'resume', 'outcome');--> statement-breakpoint
CREATE TYPE "public"."proof_entry_kind" AS ENUM('plan', 'counterfactual', 'close', 'correction');--> statement-breakpoint
CREATE TABLE "capability_stations" (
	"profile_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"station" integer NOT NULL,
	"pre_stop_station" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "capability_stations_station" CHECK ("capability_stations"."station" between 1 and 4),
	CONSTRAINT "capability_stations_pre_stop" CHECK ("capability_stations"."pre_stop_station" is null or "capability_stations"."pre_stop_station" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "ladder_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"kind" "ladder_event_kind" NOT NULL,
	"from_station" integer,
	"to_station" integer,
	"measurement_id" uuid,
	"outcome" jsonb,
	"by" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "proof_entry_kind" NOT NULL,
	"measurement_id" uuid NOT NULL,
	"proposal_id" uuid,
	"capability" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_ends_at" timestamp with time zone,
	"plan" jsonb,
	"euro_minor" bigint,
	"currency" text,
	"grade" text,
	"scored_against" text,
	"verified" boolean DEFAULT false NOT NULL,
	"corrects_id" uuid,
	"note" text,
	"payload_hash" text NOT NULL,
	CONSTRAINT "proof_ledger_grade" CHECK ("proof_ledger"."grade" is null or "proof_ledger"."grade" in ('A', 'B', 'C', 'D')),
	CONSTRAINT "proof_ledger_scored_against" CHECK ("proof_ledger"."scored_against" is null or "proof_ledger"."scored_against" in ('holdout', 'before_after', 'none')),
	CONSTRAINT "proof_ledger_money" CHECK (("proof_ledger"."euro_minor" is null) = ("proof_ledger"."currency" is null))
);
--> statement-breakpoint
ALTER TABLE "capability_stations" ADD CONSTRAINT "capability_stations_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capability_stations_pk" ON "capability_stations" USING btree ("profile_id","capability");--> statement-breakpoint
CREATE INDEX "ladder_events_profile_capability_idx" ON "ladder_events" USING btree ("profile_id","capability","at");--> statement-breakpoint
CREATE INDEX "proof_ledger_profile_at_idx" ON "proof_ledger" USING btree ("profile_id","at");--> statement-breakpoint
CREATE INDEX "proof_ledger_measurement_idx" ON "proof_ledger" USING btree ("measurement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proof_ledger_one_plan_per_proposal" ON "proof_ledger" USING btree ("proposal_id") WHERE "proof_ledger"."kind" = 'plan' and "proof_ledger"."proposal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "proof_ledger_one_close" ON "proof_ledger" USING btree ("measurement_id") WHERE "proof_ledger"."kind" = 'close';--> statement-breakpoint
CREATE UNIQUE INDEX "proof_ledger_one_counterfactual" ON "proof_ledger" USING btree ("measurement_id") WHERE "proof_ledger"."kind" = 'counterfactual';