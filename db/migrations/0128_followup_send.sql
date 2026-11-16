ALTER TYPE "public"."decision_kind" ADD VALUE 'followup_approval';--> statement-breakpoint
ALTER TYPE "public"."plan_capability" ADD VALUE 'deal_followup';--> statement-breakpoint
ALTER TABLE "deal_followups" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "deal_followups" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deal_followups" ADD COLUMN "approved_sha256" text;--> statement-breakpoint
ALTER TABLE "deal_followups" ADD COLUMN "approved_subject" text;