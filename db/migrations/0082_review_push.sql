ALTER TABLE "reviews" ADD COLUMN "push_settled_at" timestamp with time zone;--> statement-breakpoint
-- I-45d: alerts raised before review phone alerts existed are settled, so the first morning beat sends none of them.
UPDATE "reviews" SET "push_settled_at" = "alerted_at" WHERE "alerted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reviews_push_pending_idx" ON "reviews" USING btree ("profile_id") WHERE "reviews"."alerted_at" IS NOT NULL AND "reviews"."push_settled_at" IS NULL;
