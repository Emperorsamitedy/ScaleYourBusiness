CREATE TABLE "business_erasure_requests" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "labelling_records" ADD COLUMN "manifest" jsonb;