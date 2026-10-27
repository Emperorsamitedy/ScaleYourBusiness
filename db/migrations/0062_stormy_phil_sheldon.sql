CREATE TABLE "ad_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"item_id" uuid,
	"status" text DEFAULT 'building' NOT NULL,
	"build_tag" text NOT NULL,
	"campaign_id" text,
	"adset_id" text,
	"video_id" text,
	"creative_id" text,
	"ad_id" text,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"go_live_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_builds_status_known" CHECK ("ad_builds"."status" IN ('building', 'built', 'uncertain', 'failed')),
	CONSTRAINT "ad_builds_built_is_whole" CHECK ("ad_builds"."status" <> 'built' OR ("ad_builds"."campaign_id" IS NOT NULL AND "ad_builds"."adset_id" IS NOT NULL AND "ad_builds"."creative_id" IS NOT NULL AND "ad_builds"."ad_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "ad_builds" ADD CONSTRAINT "ad_builds_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_builds" ADD CONSTRAINT "ad_builds_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_builds" ADD CONSTRAINT "ad_builds_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_builds" ADD CONSTRAINT "ad_builds_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_builds" ADD CONSTRAINT "ad_builds_go_live_proposal_id_proposals_id_fk" FOREIGN KEY ("go_live_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_builds_execution_idx" ON "ad_builds" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "ad_builds_profile_idx" ON "ad_builds" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "ad_builds_item_idx" ON "ad_builds" USING btree ("item_id");