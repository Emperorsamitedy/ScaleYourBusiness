CREATE TABLE "limit_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"proposal_id" uuid NOT NULL,
	"currency" text,
	"amount_minor" bigint,
	"spend_delta_minor" bigint,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "limit_actions" ADD CONSTRAINT "limit_actions_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "limit_actions_day_idx" ON "limit_actions" USING btree ("profile_id","capability","at");--> statement-breakpoint
CREATE UNIQUE INDEX "limit_actions_one_per_proposal" ON "limit_actions" USING btree ("proposal_id");