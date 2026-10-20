ALTER TYPE "public"."decision_kind" ADD VALUE 'complaint';--> statement-breakpoint
CREATE TABLE "campaign_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD COLUMN "bounce_type" text;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD COLUMN "complained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "purchase_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_comparisons" ADD CONSTRAINT "campaign_comparisons_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_comparisons" ADD CONSTRAINT "campaign_comparisons_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_comparisons" ADD CONSTRAINT "campaign_comparisons_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_comparisons" ADD CONSTRAINT "campaign_comparisons_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_comparisons_contact_idx" ON "campaign_comparisons" USING btree ("proposal_id","contact_id") WHERE contact_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_comparisons_proposal_idx" ON "campaign_comparisons" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "campaign_sends_provider_idx" ON "campaign_sends" USING btree ("provider_message_id") WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_bounce_whole" CHECK (("campaign_sends"."bounced_at" IS NULL) = ("campaign_sends"."bounce_type" IS NULL) AND ("campaign_sends"."bounce_type" IS NULL OR "campaign_sends"."bounce_type" IN ('permanent', 'temporary', 'suppressed', 'other')));