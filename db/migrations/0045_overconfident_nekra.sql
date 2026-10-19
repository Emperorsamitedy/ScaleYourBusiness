CREATE TYPE "public"."support_channel" AS ENUM('chat', 'email');--> statement-breakpoint
CREATE TYPE "public"."support_email_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
ALTER TYPE "public"."support_ticket_reason" ADD VALUE 'emailed';--> statement-breakpoint
CREATE TABLE "support_email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "support_email_direction" NOT NULL,
	"provider_id" text,
	"message_id_header" text,
	"in_reply_to" text,
	"references_header" text,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_settings" ADD COLUMN "inbound_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "support_settings" ADD COLUMN "inbound_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "channel" "support_channel" DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "thread_token" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "suppressed_address" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_email_messages" ADD CONSTRAINT "support_email_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_email_messages" ADD CONSTRAINT "support_email_messages_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_email_messages" ADD CONSTRAINT "support_email_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_email_messages_provider_idx" ON "support_email_messages" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "support_email_messages_ticket_idx" ON "support_email_messages" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "support_email_messages_thread_idx" ON "support_email_messages" USING btree ("profile_id","message_id_header");--> statement-breakpoint
CREATE UNIQUE INDEX "support_settings_inbound_token_idx" ON "support_settings" USING btree ("inbound_token");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_thread_token_idx" ON "support_tickets" USING btree ("thread_token");--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_email_has_no_conversation" CHECK ("support_tickets"."channel" <> 'email' OR "support_tickets"."conversation_id" IS NULL);