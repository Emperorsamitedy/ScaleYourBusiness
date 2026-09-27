CREATE TYPE "public"."consent_status" AS ENUM('explicit_consent', 'implied_consent', 'no_consent', 'unsure');--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'erasure';--> statement-breakpoint
CREATE TABLE "contact_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text,
	"name" text,
	"phone" text,
	"consent_status" "consent_status" DEFAULT 'unsure' NOT NULL,
	"consent_source" text NOT NULL,
	"consent_captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_suppressions_idx" ON "contact_suppressions" USING btree ("account_id","email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_account_email_idx" ON "contacts" USING btree ("account_id","email") WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_account_idx" ON "contacts" USING btree ("account_id");