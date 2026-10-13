ALTER TYPE "public"."decision_kind" ADD VALUE 'takeover';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;