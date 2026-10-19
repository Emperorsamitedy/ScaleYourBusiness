ALTER TABLE "connections" ADD COLUMN "access_tier" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "access_tier_seen_at" timestamp with time zone;