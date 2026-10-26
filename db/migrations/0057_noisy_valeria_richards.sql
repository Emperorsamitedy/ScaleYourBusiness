CREATE TYPE "public"."weekly_summary_status" AS ENUM('sending', 'sent', 'refused', 'unknown');--> statement-breakpoint
CREATE TABLE "weekly_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"iso_week" text NOT NULL,
	"status" "weekly_summary_status" DEFAULT 'sending' NOT NULL,
	"quiet" boolean NOT NULL,
	"line_count" integer NOT NULL,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD CONSTRAINT "weekly_summaries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_summaries_account_week_idx" ON "weekly_summaries" USING btree ("account_id","iso_week");