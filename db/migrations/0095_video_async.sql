-- P6-03, the owner's decision of 2026-11-09: AI video is submitted at once and collected in the background (status URL, checks, lease, deadline sweep).
ALTER TABLE "media_candidates" ADD COLUMN "status_url" text;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD COLUMN "cancel_url" text;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD COLUMN "checks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_candidates" ADD COLUMN "waiting" text;--> statement-breakpoint
CREATE INDEX "media_candidates_pending_idx" ON "media_candidates" USING btree ("created_at") WHERE "media_candidates"."status" = 'generating';--> statement-breakpoint
ALTER TABLE "media_candidates" ADD CONSTRAINT "media_candidates_checks" CHECK ("media_candidates"."checks" >= 0);