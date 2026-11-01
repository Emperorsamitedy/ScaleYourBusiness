ALTER TABLE "accounts" ADD COLUMN "reporting_currency_chosen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_language_known" CHECK ("business_profiles"."language" in ('en', 'es-ES', 'de-DE', 'fr-FR', 'hu-HU', 'ru-RU', 'zh-Hans'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_language_known" CHECK ("users"."language" is null or "users"."language" in ('en', 'es-ES', 'de-DE', 'fr-FR', 'hu-HU', 'ru-RU', 'zh-Hans'));