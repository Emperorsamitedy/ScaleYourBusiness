CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'executed', 'blocked');--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"module" text NOT NULL,
	"originating_finding" text,
	"action" jsonb NOT NULL,
	"scenario" jsonb NOT NULL,
	"reversibility" jsonb NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"blocked_by_limit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"execution_result" jsonb,
	CONSTRAINT "proposals_requires_approval_true" CHECK ("proposals"."requires_approval" = true),
	CONSTRAINT "proposals_blocked_names_limit" CHECK ("proposals"."status" <> 'blocked' OR "proposals"."blocked_by_limit" IS NOT NULL),
	CONSTRAINT "proposals_decided_by_human" CHECK ("proposals"."status" NOT IN ('approved', 'rejected', 'executed') OR ("proposals"."decided_by" IS NOT NULL AND "proposals"."decided_at" IS NOT NULL)),
	CONSTRAINT "proposals_rejection_has_reason" CHECK ("proposals"."status" <> 'rejected' OR "proposals"."rejection_reason" IS NOT NULL),
	CONSTRAINT "proposals_executed_has_result" CHECK ("proposals"."status" <> 'executed' OR "proposals"."execution_result" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_profile_status_idx" ON "proposals" USING btree ("profile_id","status");