CREATE TYPE "public"."content_status" AS ENUM('drafted', 'queued', 'publishing', 'published', 'failed', 'withdrawn');--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "status" "content_status" DEFAULT 'drafted' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "platform_post_id" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "publish_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "publish_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_publish_proposal_id_proposals_id_fk" FOREIGN KEY ("publish_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_publish_execution_id_executions_id_fk" FOREIGN KEY ("publish_execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_items_status_idx" ON "content_items" USING btree ("profile_id","status");--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_published_names_platform" CHECK ("content_items"."status" NOT IN ('published', 'withdrawn') OR ("content_items"."platform" IS NOT NULL AND "content_items"."platform_post_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_published_has_time" CHECK ("content_items"."status" <> 'published' OR "content_items"."published_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_failed_has_error" CHECK ("content_items"."status" <> 'failed' OR "content_items"."last_error" IS NOT NULL);