CREATE TYPE "public"."support_reply_status" AS ENUM('drafted', 'declined', 'approved', 'sending', 'sent', 'failed');--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'reply_approval';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'reply_decline';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'reply_send';--> statement-breakpoint
CREATE TABLE "support_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "support_reply_status" DEFAULT 'drafted' NOT NULL,
	"ai_drafted" boolean NOT NULL,
	"drafted_text" text,
	"grounded_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_cost_eur" numeric(10, 6) DEFAULT '0' NOT NULL,
	"body" text NOT NULL,
	"sent_text" text,
	"sent_text_sha256" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_id" text,
	"outcome_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_replies_approval_recorded" CHECK ("support_replies"."status" IN ('drafted', 'declined') OR ("support_replies"."approved_by" IS NOT NULL AND "support_replies"."approved_at" IS NOT NULL AND "support_replies"."sent_text" IS NOT NULL AND "support_replies"."sent_text_sha256" IS NOT NULL)),
	CONSTRAINT "support_replies_ai_has_draft" CHECK (NOT "support_replies"."ai_drafted" OR "support_replies"."drafted_text" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "draft_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_replies" ADD CONSTRAINT "support_replies_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_replies" ADD CONSTRAINT "support_replies_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_replies" ADD CONSTRAINT "support_replies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_replies" ADD CONSTRAINT "support_replies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_replies_ticket_idx" ON "support_replies" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_replies_live_idx" ON "support_replies" USING btree ("ticket_id") WHERE status IN ('drafted', 'approved', 'sending');