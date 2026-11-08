-- P6-08 (rules 22, 32, 34): consented call recording — the owner's switch (off by default), the recording notice's stamp, and the recordings kept sealed in SYB storage.
CREATE TYPE "public"."phone_recording_status" AS ENUM('pending', 'stored', 'refused');--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'recording_consent';--> statement-breakpoint
CREATE TABLE "phone_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_sid" text NOT NULL,
	"call_id" uuid,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "phone_recording_status" DEFAULT 'pending' NOT NULL,
	"at_twilio" boolean DEFAULT true NOT NULL,
	"storage_url" text,
	"bytes" integer,
	"content_type" text,
	"duration_seconds" integer,
	"channels" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stored_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"purge_requested_at" timestamp with time zone,
	CONSTRAINT "phone_recordings_sid_shape" CHECK ("phone_recordings"."recording_sid" ~ '^RE[0-9a-fA-F]{32}$'),
	CONSTRAINT "phone_recordings_stored_only" CHECK ("phone_recordings"."storage_url" IS NULL OR "phone_recordings"."status" = 'stored')
);
--> statement-breakpoint
ALTER TABLE "phone_calls" ADD COLUMN "recording_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_settings" ADD COLUMN "record_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_settings" ADD COLUMN "record_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_settings" ADD COLUMN "record_changed_by" uuid;--> statement-breakpoint
ALTER TABLE "phone_recordings" ADD CONSTRAINT "phone_recordings_call_id_phone_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."phone_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_recordings_sid_idx" ON "phone_recordings" USING btree ("recording_sid");--> statement-breakpoint
CREATE INDEX "phone_recordings_call_idx" ON "phone_recordings" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "phone_recordings_upkeep_idx" ON "phone_recordings" USING btree ("status","expires_at");