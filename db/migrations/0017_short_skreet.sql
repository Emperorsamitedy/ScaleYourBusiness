CREATE TABLE "diagnosis_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text NOT NULL,
	"completeness" numeric NOT NULL,
	"cost_eur" numeric NOT NULL,
	"unit_economics" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"recommendations" jsonb NOT NULL,
	"data_gaps" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagnosis_reports" ADD CONSTRAINT "diagnosis_reports_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_reports" ADD CONSTRAINT "diagnosis_reports_snapshot_id_profile_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."profile_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnosis_reports_profile_idx" ON "diagnosis_reports" USING btree ("profile_id","generated_at");