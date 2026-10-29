CREATE TABLE "review_settings" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"inbound_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"inbound_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parse_month" text,
	"parse_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "review_settings_parse_calls_nonneg" CHECK ("review_settings"."parse_calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"source" text NOT NULL,
	"read_by" text NOT NULL,
	"stars" integer,
	"reviewer" text,
	"text" text,
	"link" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" text,
	"dedupe_key" text NOT NULL,
	"sender_auth" "support_sender_auth",
	"worth_knowing" boolean NOT NULL,
	"alerted_at" timestamp with time zone,
	"draft" text,
	"drafted_at" timestamp with time zone,
	"draft_calls" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reviews_stars_range" CHECK ("reviews"."stars" IS NULL OR "reviews"."stars" BETWEEN 1 AND 5),
	CONSTRAINT "reviews_source" CHECK ("reviews"."source" IN ('email', 'paste')),
	CONSTRAINT "reviews_read_by" CHECK ("reviews"."read_by" IN ('parser', 'model', 'owner', 'unread')),
	CONSTRAINT "reviews_draft_calls_range" CHECK ("reviews"."draft_calls" BETWEEN 0 AND 3),
	CONSTRAINT "reviews_expiry_after_receipt" CHECK ("reviews"."expires_at" > "reviews"."received_at")
);
--> statement-breakpoint
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_settings_inbound_token_idx" ON "review_settings" USING btree ("inbound_token");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_dedupe_idx" ON "reviews" USING btree ("profile_id","platform","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_provider_idx" ON "reviews" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "reviews_profile_received_idx" ON "reviews" USING btree ("profile_id","received_at");--> statement-breakpoint
CREATE INDEX "reviews_expires_idx" ON "reviews" USING btree ("expires_at");