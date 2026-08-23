ALTER TABLE "validation_findings" DROP CONSTRAINT "validation_findings_profile_id_business_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;