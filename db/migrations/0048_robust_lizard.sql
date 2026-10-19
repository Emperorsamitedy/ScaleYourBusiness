CREATE TYPE "public"."campaign_send_status" AS ENUM('pending', 'refused', 'sending', 'sent', 'failed', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'law_review';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'campaign_approval';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'unsubscribe';--> statement-breakpoint
CREATE TABLE "campaign_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"email_hash" text,
	"status" "campaign_send_status" DEFAULT 'pending' NOT NULL,
	"refused_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_message_id" text,
	"idempotency_key" text NOT NULL,
	"unsubscribe_token_hash" text,
	"sender_name" text,
	"body_sha256" text,
	"provider_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "campaign_sends_claimed_has_address" CHECK ("campaign_sends"."status" IN ('pending', 'refused') OR ("campaign_sends"."email_hash" IS NOT NULL AND "campaign_sends"."claimed_at" IS NOT NULL AND "campaign_sends"."unsubscribe_token_hash" IS NOT NULL)),
	CONSTRAINT "campaign_sends_refused_has_reason" CHECK ("campaign_sends"."status" <> 'refused' OR jsonb_array_length("campaign_sends"."refused_reasons") > 0),
	CONSTRAINT "campaign_sends_sent_has_time" CHECK ("campaign_sends"."status" <> 'sent' OR "campaign_sends"."sent_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "jurisdiction_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewer" text NOT NULL,
	"reviewed_on" date NOT NULL,
	"table_sha256" text NOT NULL,
	"note" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jurisdiction_reviews_reviewer_named" CHECK (length(trim("jurisdiction_reviews"."reviewer")) > 0),
	CONSTRAINT "jurisdiction_reviews_hash_shape" CHECK ("jurisdiction_reviews"."table_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "executions" DROP CONSTRAINT "executions_held_for_known";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "sender_name" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "approved_sha256" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "approved_subject" text;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_contact_idx" ON "campaign_sends" USING btree ("proposal_id","contact_id") WHERE contact_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_address_idx" ON "campaign_sends" USING btree ("proposal_id","email_hash") WHERE email_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_idempotency_idx" ON "campaign_sends" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_token_idx" ON "campaign_sends" USING btree ("unsubscribe_token_hash") WHERE unsubscribe_token_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_sends_proposal_idx" ON "campaign_sends" USING btree ("proposal_id","status");--> statement-breakpoint
CREATE INDEX "jurisdiction_reviews_recorded_idx" ON "jurisdiction_reviews" USING btree ("recorded_at");--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_sender_on_email_campaign" CHECK (("connections"."sender_name" IS NULL AND "connections"."reply_to" IS NULL) OR ("connections"."provider" = 'email_campaign' AND "connections"."purpose" = 'execute' AND "connections"."sender_name" IS NOT NULL AND "connections"."reply_to" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_approval_whole" CHECK (("content_items"."approved_at" IS NULL) = ("content_items"."approved_by" IS NULL) AND ("content_items"."approved_at" IS NULL) = ("content_items"."approved_sha256" IS NULL) AND ("content_items"."approved_at" IS NULL) = ("content_items"."approved_subject" IS NULL));--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_approval_is_email" CHECK ("content_items"."approved_at" IS NULL OR "content_items"."kind" = 'email');--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_held_for_known" CHECK ("executions"."held_for" IS NULL OR ("executions"."held_for" IN ('reconnect', 'stop', 'remaining') AND "executions"."status" = 'failed'));--> statement-breakpoint
-- P4-15: sending is a write. The measure-row trigger (migration 0030) mirrors
-- WRITE_CAPABLE in lib/connectors/scopes.ts, which now also names "send" —
-- so a measurement connection can never hold a send scope either.
-- lib/execution/connections.test.ts proves the two agree, both directions.
CREATE OR REPLACE FUNCTION connections_measure_rows_read_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  IF NEW.purpose = 'measure' THEN
    FOR s IN SELECT jsonb_array_elements_text(NEW.granted_scopes) LOOP
      IF s ~* '(write|manage|admin|delete|create|update|modify|edit|publish|send|full[_.-]?access)'
         OR s = '*'
         OR s ~* '^all$' THEN
        RAISE EXCEPTION 'connections: a measurement connection cannot hold the write-capable scope "%"', s
          USING ERRCODE = 'check_violation',
                HINT = 'Write access is its own consent (rule 13). Connect it through lib/execution/connections with purpose = execute.';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
