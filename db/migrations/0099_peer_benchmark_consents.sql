CREATE TABLE "peer_benchmark_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consented_by" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" uuid
);
--> statement-breakpoint
ALTER TABLE "peer_benchmark_consents" ADD CONSTRAINT "peer_benchmark_consents_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "peer_benchmark_consents_one_live" ON "peer_benchmark_consents" USING btree ("profile_id") WHERE "peer_benchmark_consents"."withdrawn_at" is null;