CREATE TYPE "public"."anomaly_direction" AS ENUM('drop', 'spike');--> statement-breakpoint
CREATE TYPE "public"."anomaly_severity" AS ENUM('notice', 'interrupt');--> statement-breakpoint
CREATE TABLE "anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"dimension_key" text NOT NULL,
	"direction" "anomaly_direction" NOT NULL,
	"severity" "anomaly_severity" NOT NULL,
	"first_date" date NOT NULL,
	"last_date" date NOT NULL,
	"run_days" integer NOT NULL,
	"actual" numeric(18, 4) NOT NULL,
	"expected" numeric(18, 4) NOT NULL,
	"deviation" numeric(10, 3) NOT NULL,
	"detail" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anomalies_open_idx" ON "anomalies" USING btree ("connection_id","metric_key","dimension_key") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "anomalies_profile_idx" ON "anomalies" USING btree ("profile_id","detected_at");