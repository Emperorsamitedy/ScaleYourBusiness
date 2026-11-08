-- P6-07 (rules 19, 22, 34): the owner's WhatsApp opt-in as a recorded fact, and the weekly summary's WhatsApp outcome beside the email's on the one claimed row. status becomes nullable: null = no email that week (WhatsApp alone).
CREATE TABLE "whatsapp_optins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"phone_number" text,
	"consent_version" text NOT NULL,
	"consent_locale" text NOT NULL,
	"consent_sha256" text NOT NULL,
	"opted_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	CONSTRAINT "whatsapp_optins_number" CHECK (("whatsapp_optins"."phone_number" IS NULL) = ("whatsapp_optins"."erased_at" IS NOT NULL) AND ("whatsapp_optins"."phone_number" IS NULL OR "whatsapp_optins"."phone_number" ~ '^\+[1-9][0-9]{6,14}$')),
	CONSTRAINT "whatsapp_optins_erased_withdrawn" CHECK ("whatsapp_optins"."erased_at" IS NULL OR "whatsapp_optins"."withdrawn_at" IS NOT NULL),
	CONSTRAINT "whatsapp_optins_hash" CHECK ("whatsapp_optins"."consent_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "weekly_summaries" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD COLUMN "whatsapp_status" "weekly_summary_status";--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD COLUMN "whatsapp_sid" text;--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD COLUMN "whatsapp_error_code" integer;--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD COLUMN "whatsapp_optin_id" uuid;--> statement-breakpoint
ALTER TABLE "whatsapp_optins" ADD CONSTRAINT "whatsapp_optins_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_optins" ADD CONSTRAINT "whatsapp_optins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_optins_live_idx" ON "whatsapp_optins" USING btree ("user_id") WHERE "whatsapp_optins"."withdrawn_at" IS NULL;--> statement-breakpoint
CREATE INDEX "whatsapp_optins_account_idx" ON "whatsapp_optins" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD CONSTRAINT "weekly_summaries_whatsapp_optin_id_whatsapp_optins_id_fk" FOREIGN KEY ("whatsapp_optin_id") REFERENCES "public"."whatsapp_optins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD CONSTRAINT "weekly_summaries_some_channel" CHECK ("weekly_summaries"."status" IS NOT NULL OR "weekly_summaries"."whatsapp_status" IS NOT NULL);