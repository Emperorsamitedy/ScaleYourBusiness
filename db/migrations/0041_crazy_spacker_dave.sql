ALTER TYPE "public"."decision_kind" ADD VALUE 'change_request';--> statement-breakpoint
ALTER TYPE "public"."proposal_status" ADD VALUE 'changes_requested';--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "change_request" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_change_request_recorded" CHECK ("proposals"."status"::text <> 'changes_requested' OR ("proposals"."decided_by" IS NOT NULL AND "proposals"."decided_at" IS NOT NULL AND "proposals"."change_request" IS NOT NULL));