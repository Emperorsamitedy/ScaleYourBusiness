ALTER TABLE "support_conversations" ADD COLUMN "reserved_eur" numeric(10, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD COLUMN "client_hash" text;--> statement-breakpoint
CREATE INDEX "support_conversations_client_idx" ON "support_conversations" USING btree ("profile_id","client_hash","started_at");