CREATE TYPE "public"."cost_bucket" AS ENUM('fixed', 'variable');--> statement-breakpoint
CREATE TABLE "cost_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"bucket" "cost_bucket" NOT NULL,
	"scales_with_sales" boolean DEFAULT false NOT NULL,
	"linked_offer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_linked_offer_id_offers_id_fk" FOREIGN KEY ("linked_offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_segments" ADD CONSTRAINT "customer_segments_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_items_profile_idx" ON "cost_items" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "customer_segments_profile_idx" ON "customer_segments" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "goals_profile_idx" ON "goals" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "staff_roles_profile_idx" ON "staff_roles" USING btree ("profile_id");