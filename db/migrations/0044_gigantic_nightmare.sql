ALTER TABLE "content_items" ADD COLUMN "paused_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD COLUMN "usage" jsonb;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "held_for" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_paused_connection_id_connections_id_fk" FOREIGN KEY ("paused_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_paused_is_failed" CHECK ("content_items"."paused_connection_id" IS NULL OR "content_items"."status" = 'failed');--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_held_for_known" CHECK ("executions"."held_for" IS NULL OR ("executions"."held_for" IN ('reconnect', 'stop') AND "executions"."status" = 'failed'));