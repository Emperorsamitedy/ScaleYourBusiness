-- I-45a (2026-11-01): reviews read from the owner's Google Business Profile,
-- under a write consent used only to read. A review may now come from
-- 'google' (source), read by Google's own API ('api', read_by).
-- review_settings keeps the consented location's public title and how the
-- last read went (a closed code). Additive, nullable, forward-only; the two
-- review checks only widen.
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_source";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_read_by";--> statement-breakpoint
ALTER TABLE "review_settings" ADD COLUMN "google_location_title" text;--> statement-breakpoint
ALTER TABLE "review_settings" ADD COLUMN "google_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_settings" ADD COLUMN "google_read_outcome" text;--> statement-breakpoint
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_google_read_outcome" CHECK ("review_settings"."google_read_outcome" IS NULL OR "review_settings"."google_read_outcome" IN ('ok', 'auth', 'permission', 'quota', 'unavailable', 'refused', 'fence', 'internal'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_source" CHECK ("reviews"."source" IN ('email', 'paste', 'google'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_read_by" CHECK ("reviews"."read_by" IN ('parser', 'model', 'owner', 'unread', 'api'));