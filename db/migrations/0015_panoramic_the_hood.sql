CREATE TABLE "profile_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"fact_count" integer NOT NULL,
	"entity_count" integer NOT NULL,
	"reason" text DEFAULT 'manual' NOT NULL,
	"entities" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_records" (
	"snapshot_id" uuid NOT NULL,
	"record_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_records" ADD CONSTRAINT "snapshot_records_snapshot_id_profile_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."profile_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_records" ADD CONSTRAINT "snapshot_records_record_id_field_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."field_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_snapshots_profile_idx" ON "profile_snapshots" USING btree ("profile_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_records_pk" ON "snapshot_records" USING btree ("snapshot_id","record_id");