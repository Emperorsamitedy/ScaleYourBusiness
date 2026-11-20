CREATE TABLE "warning_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"push_settled_at" timestamp with time zone,
	"email_claimed_at" timestamp with time zone,
	"email_outcome" text
);
--> statement-breakpoint
ALTER TABLE "warning_alerts" ADD CONSTRAINT "warning_alerts_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warning_alerts" ADD CONSTRAINT "warning_alerts_activity_id_watch_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."watch_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warning_alerts_activity_uq" ON "warning_alerts" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "warning_alerts_profile_idx" ON "warning_alerts" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "warning_alerts_push_pending_idx" ON "warning_alerts" USING btree ("profile_id") WHERE push_settled_at IS NULL;