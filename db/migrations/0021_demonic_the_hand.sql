CREATE TYPE "public"."mode_kind" AS ENUM('instant', 'watching');--> statement-breakpoint
CREATE TABLE "account_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"module" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mode_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"mode" "mode_kind" NOT NULL,
	"watch_weeks" integer,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inputs" jsonb NOT NULL,
	"reasoning" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"owner_override" jsonb,
	"review_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"detail" text NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "account_modules" ADD CONSTRAINT "account_modules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode_decisions" ADD CONSTRAINT "mode_decisions_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_activity" ADD CONSTRAINT "watch_activity_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_modules_unique_idx" ON "account_modules" USING btree ("account_id","module");--> statement-breakpoint
CREATE INDEX "mode_decisions_profile_idx" ON "mode_decisions" USING btree ("profile_id","decided_at");--> statement-breakpoint
CREATE INDEX "watch_activity_profile_at_idx" ON "watch_activity" USING btree ("profile_id","at");