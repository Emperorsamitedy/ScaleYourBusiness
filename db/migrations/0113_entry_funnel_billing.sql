CREATE TABLE "billing_events" (
	"stripe_event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnosis_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'deferred' NOT NULL,
	"subscription_id" uuid,
	"stripe_coupon_id" text,
	"applied_invoice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "diagnosis_credits_status" CHECK ("diagnosis_credits"."status" in ('deferred', 'applied', 'needs_review')),
	CONSTRAINT "diagnosis_credits_amount" CHECK ("diagnosis_credits"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "entry_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"answers" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"locale" text NOT NULL,
	"referred_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guarantee_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "guarantee_credits_status" CHECK ("guarantee_credits"."status" in ('pending', 'applied'))
);
--> statement-breakpoint
CREATE TABLE "guarantee_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"quarter" text NOT NULL,
	"tier" text NOT NULL,
	"fee_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"entries" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"inputs_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "parent_subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "diagnosis_credits" ADD CONSTRAINT "diagnosis_credits_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantee_evaluations" ADD CONSTRAINT "guarantee_evaluations_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diagnosis_credits_payment" ON "diagnosis_credits" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_leads_token" ON "entry_leads" USING btree ("token");--> statement-breakpoint
CREATE INDEX "entry_leads_ref" ON "entry_leads" USING btree ("referred_by");--> statement-breakpoint
CREATE UNIQUE INDEX "guarantee_credits_evaluation" ON "guarantee_credits" USING btree ("evaluation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guarantee_evaluations_quarter" ON "guarantee_evaluations" USING btree ("subscription_id","quarter");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_idx" ON "subscriptions" USING btree ("stripe_subscription_id") WHERE "subscriptions"."stripe_subscription_id" is not null and "subscriptions"."status" <> 'canceled';--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_interval" CHECK ("subscriptions"."billing_interval" in ('month', 'year'));