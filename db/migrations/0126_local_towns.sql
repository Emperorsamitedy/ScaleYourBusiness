CREATE TABLE "local_towns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country" text NOT NULL,
	"name" text NOT NULL,
	"normalized" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"osm_relation" bigint,
	"population" integer,
	"counts" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counted_at" timestamp with time zone,
	CONSTRAINT "local_towns_status_known" CHECK ("local_towns"."status" in ('queued', 'counted', 'not_found', 'gave_up'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_towns_place" ON "local_towns" USING btree ("country","normalized");--> statement-breakpoint
CREATE INDEX "local_towns_status" ON "local_towns" USING btree ("status","requested_at");