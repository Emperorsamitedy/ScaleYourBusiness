CREATE TYPE "public"."connection_status" AS ENUM('connected', 'paused', 'failed', 'disconnected');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "connection_status" DEFAULT 'connected' NOT NULL,
	"encrypted_secret" text,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor" text,
	"last_sync_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"pages" integer NOT NULL,
	"observations_upserted" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "metric_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"metric_key" text NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dimension_key" text NOT NULL,
	"period_date" date NOT NULL,
	"value_minor" bigint,
	"currency" text,
	"value_num" numeric(18, 4),
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_syncs" ADD CONSTRAINT "connector_syncs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_active_idx" ON "connections" USING btree ("account_id","provider") WHERE status <> 'disconnected';--> statement-breakpoint
CREATE INDEX "connections_account_idx" ON "connections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "connector_syncs_connection_idx" ON "connector_syncs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_observations_natural_idx" ON "metric_observations" USING btree ("connection_id","metric_key","dimension_key","period_date");--> statement-breakpoint
CREATE INDEX "metric_observations_series_idx" ON "metric_observations" USING btree ("connection_id","metric_key","period_date");