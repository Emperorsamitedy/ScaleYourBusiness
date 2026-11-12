ALTER TABLE "phone_calls" ADD COLUMN "consent" text;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD COLUMN "recording_asked" boolean DEFAULT false NOT NULL;