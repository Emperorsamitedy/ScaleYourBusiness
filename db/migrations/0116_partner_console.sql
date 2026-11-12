CREATE TYPE "public"."firm_role" AS ENUM('principal', 'manager', 'staff');--> statement-breakpoint
CREATE TYPE "public"."firm_type" AS ENUM('accountancy', 'bookkeeping', 'marketing_agency', 'consultancy');--> statement-breakpoint
ALTER TYPE "public"."decision_actor" ADD VALUE 'partner';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'mandate_grant';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'mandate_revoke';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'partner_action';--> statement-breakpoint
CREATE TABLE "firm_commentary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"section" text NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "firm_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "firm_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "firm_metric_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"period" text NOT NULL,
	"currency" text NOT NULL,
	"verified_minor" bigint NOT NULL,
	"leaks_open" integer NOT NULL,
	"leaks_fixed" integer NOT NULL,
	"clients_active" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"type" "firm_type" NOT NULL,
	"tier" text DEFAULT 'partner_starter' NOT NULL,
	"white_label" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rev_share_bp" integer DEFAULT 1500 NOT NULL,
	"billing_mode" text DEFAULT 'firm_pays' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandate_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"business_name" text NOT NULL,
	"email" text NOT NULL,
	"country" text,
	"locale" text NOT NULL,
	"scopes" text[] NOT NULL,
	"months" integer DEFAULT 12 NOT NULL,
	"evidence_ref" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"mandate_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"evidence_ref" text NOT NULL,
	CONSTRAINT "mandates_window" CHECK ("mandates"."expires_at" > "mandates"."granted_at"),
	CONSTRAINT "mandates_scopes" CHECK (cardinality("mandates"."scopes") > 0 and "mandates"."scopes" <@ array['read_diagnosis','approve_actions','manage_connectors','receive_reports']::text[]),
	CONSTRAINT "mandates_evidence" CHECK (length(trim("mandates"."evidence_ref")) > 0)
);
--> statement-breakpoint
ALTER TABLE "firm_commentary" ADD CONSTRAINT "firm_commentary_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_commentary" ADD CONSTRAINT "firm_commentary_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_members" ADD CONSTRAINT "firm_members_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_metric_rollups" ADD CONSTRAINT "firm_metric_rollups_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_requests" ADD CONSTRAINT "mandate_requests_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "firm_commentary_live" ON "firm_commentary" USING btree ("firm_id","profile_id","section") WHERE "firm_commentary"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "firm_members_one_live" ON "firm_members" USING btree ("firm_id","user_id") WHERE "firm_members"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "firm_metric_rollups_key" ON "firm_metric_rollups" USING btree ("firm_id","period","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "mandate_requests_token" ON "mandate_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mandate_requests_open" ON "mandate_requests" USING btree ("firm_id","email") WHERE "mandate_requests"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "mandates_profile_idx" ON "mandates" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "mandates_firm_idx" ON "mandates" USING btree ("firm_id");