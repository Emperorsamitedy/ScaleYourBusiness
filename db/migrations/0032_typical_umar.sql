CREATE TYPE "public"."knowledge_status" AS ENUM('public', 'retired');--> statement-breakpoint
CREATE TYPE "public"."support_conversation_status" AS ENUM('open', 'escalated', 'closed');--> statement-breakpoint
CREATE TYPE "public"."support_role" AS ENUM('customer', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_reason" AS ENUM('customer_asked', 'no_answer', 'cost_cap', 'conversation_cap');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('open', 'answered', 'closed');--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "knowledge_status" DEFAULT 'public' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "knowledge_entries_retired_has_time" CHECK ("knowledge_entries"."status" <> 'retired' OR "knowledge_entries"."retired_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "support_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"token" text NOT NULL,
	"status" "support_conversation_status" DEFAULT 'open' NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"cost_eur" numeric(10, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "support_role" NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"grounded_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_eur" numeric(10, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_settings" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"site_key" text NOT NULL,
	"business_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"reason" "support_ticket_reason" NOT NULL,
	"summary" text NOT NULL,
	"status" "support_ticket_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."support_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_settings" ADD CONSTRAINT "support_settings_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_settings" ADD CONSTRAINT "support_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."support_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_entries_profile_idx" ON "knowledge_entries" USING btree ("profile_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "support_conversations_token_idx" ON "support_conversations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "support_conversations_profile_idx" ON "support_conversations" USING btree ("profile_id","started_at");--> statement-breakpoint
CREATE INDEX "support_messages_conversation_idx" ON "support_messages" USING btree ("conversation_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_settings_site_key_idx" ON "support_settings" USING btree ("site_key");--> statement-breakpoint
CREATE INDEX "support_tickets_profile_idx" ON "support_tickets" USING btree ("profile_id","status","created_at");