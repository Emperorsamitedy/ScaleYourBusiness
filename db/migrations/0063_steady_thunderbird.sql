CREATE TYPE "public"."deal_stage" AS ENUM('lead', 'qualified', 'proposal_sent', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "deal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"source" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_events_kind_known" CHECK ("deal_events"."kind" IN ('created', 'stage', 'value', 'next_step', 'expected_close', 'contacted'))
);
--> statement-breakpoint
CREATE TABLE "deal_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"body" text NOT NULL,
	"disclosure" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"company" text,
	"title" text NOT NULL,
	"stage" "deal_stage" DEFAULT 'lead' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_minor" bigint,
	"value_currency" text,
	"value_basis" text,
	"expected_close" date,
	"next_step" text,
	"next_step_due" date,
	"last_contact_at" timestamp with time zone,
	"source" text NOT NULL,
	"source_note" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_value_whole" CHECK (("deals"."value_minor" IS NULL) = ("deals"."value_currency" IS NULL) AND ("deals"."value_minor" IS NULL) = ("deals"."value_basis" IS NULL)),
	CONSTRAINT "deals_value_not_negative" CHECK ("deals"."value_minor" IS NULL OR "deals"."value_minor" >= 0),
	CONSTRAINT "deals_value_basis_known" CHECK ("deals"."value_basis" IS NULL OR "deals"."value_basis" IN ('quoted', 'estimated')),
	CONSTRAINT "deals_source_known" CHECK ("deals"."source" IN ('owner_input', 'import')),
	CONSTRAINT "deals_title_present" CHECK (length(trim("deals"."title")) > 0),
	CONSTRAINT "deals_closed_iff_won_or_lost" CHECK (("deals"."closed_at" IS NOT NULL) = ("deals"."stage" IN ('won', 'lost'))),
	CONSTRAINT "deals_due_has_step" CHECK ("deals"."next_step_due" IS NULL OR ("deals"."next_step" IS NOT NULL AND length(trim("deals"."next_step")) > 0))
);
--> statement-breakpoint
ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_followups" ADD CONSTRAINT "deal_followups_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_followups" ADD CONSTRAINT "deal_followups_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_followups" ADD CONSTRAINT "deal_followups_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_events_deal_idx" ON "deal_events" USING btree ("deal_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_followups_proposal_idx" ON "deal_followups" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "deal_followups_account_idx" ON "deal_followups" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "deals_profile_stage_idx" ON "deals" USING btree ("profile_id","stage");--> statement-breakpoint
CREATE INDEX "deals_contact_idx" ON "deals" USING btree ("contact_id");