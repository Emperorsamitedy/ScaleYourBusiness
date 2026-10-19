ALTER TABLE "support_settings" ADD COLUMN "reply_hours" integer;--> statement-breakpoint
ALTER TABLE "support_settings" ADD COLUMN "reply_hours_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_settings" ADD COLUMN "notify_owner" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "support_settings" ADD COLUMN "owner_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_settings" ADD CONSTRAINT "support_settings_reply_hours_range" CHECK ("support_settings"."reply_hours" IS NULL OR ("support_settings"."reply_hours" BETWEEN 1 AND 720 AND "support_settings"."reply_hours_set_at" IS NOT NULL));