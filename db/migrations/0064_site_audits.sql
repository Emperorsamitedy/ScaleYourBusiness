CREATE TABLE "site_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"status" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text NOT NULL,
	"origin" text NOT NULL,
	"platform" jsonb,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"path" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pagespeed_calls" integer DEFAULT 0 NOT NULL,
	"page_reads" integer DEFAULT 0 NOT NULL,
	"pagespeed_keyed" boolean DEFAULT false NOT NULL,
	"pagespeed_note" text,
	"reason" text,
	CONSTRAINT "site_audits_status" CHECK ("site_audits"."status" IN ('read', 'failed')),
	CONSTRAINT "site_audits_failed_says_why" CHECK ("site_audits"."status" <> 'failed' OR "site_audits"."reason" IS NOT NULL),
	CONSTRAINT "site_audits_calls_nonneg" CHECK ("site_audits"."pagespeed_calls" >= 0 AND "site_audits"."page_reads" >= 0)
);
--> statement-breakpoint
ALTER TABLE "site_audits" ADD CONSTRAINT "site_audits_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_audits_profile_idx" ON "site_audits" USING btree ("profile_id","ran_at");--> statement-breakpoint
CREATE INDEX "site_audits_origin_idx" ON "site_audits" USING btree ("origin","ran_at");