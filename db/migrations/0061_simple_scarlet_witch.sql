CREATE TABLE "creative_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"campaign" text NOT NULL,
	"goal_id" uuid,
	"niche_read_id" uuid,
	"brief" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"model" text NOT NULL,
	"attempts" integer NOT NULL,
	"rejections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_eur" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_briefs_attempts" CHECK ("creative_briefs"."attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "niche_ad_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"source" text DEFAULT 'meta_ad_library' NOT NULL,
	"status" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"country" text,
	"terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"ads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	CONSTRAINT "niche_ad_reads_status" CHECK ("niche_ad_reads"."status" IN ('read', 'failed')),
	CONSTRAINT "niche_ad_reads_failed_says_why" CHECK ("niche_ad_reads"."status" <> 'failed' OR "niche_ad_reads"."reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD CONSTRAINT "creative_briefs_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD CONSTRAINT "creative_briefs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_briefs" ADD CONSTRAINT "creative_briefs_niche_read_id_niche_ad_reads_id_fk" FOREIGN KEY ("niche_read_id") REFERENCES "public"."niche_ad_reads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "niche_ad_reads" ADD CONSTRAINT "niche_ad_reads_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creative_briefs_profile_idx" ON "creative_briefs" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "niche_ad_reads_profile_idx" ON "niche_ad_reads" USING btree ("profile_id","read_at");