ALTER TYPE "public"."decision_kind" ADD VALUE 'campaign_review';--> statement-breakpoint
CREATE TABLE "campaign_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"reviewer" text NOT NULL,
	"reviewed_on" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_reviews_reviewer_named" CHECK (length(trim("campaign_reviews"."reviewer")) > 0)
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "held_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_reviews" ADD CONSTRAINT "campaign_reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reviews" ADD CONSTRAINT "campaign_reviews_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_reviews_proposal_idx" ON "campaign_reviews" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "campaign_reviews_account_idx" ON "campaign_reviews" USING btree ("account_id","recorded_at");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_held_until_held" CHECK ("executions"."held_until" IS NULL OR "executions"."held_for" IS NOT NULL);