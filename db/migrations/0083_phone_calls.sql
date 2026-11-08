CREATE TYPE "public"."phone_call_outcome" AS ENUM('answered', 'message', 'handed_over', 'hung_up');--> statement-breakpoint
CREATE TYPE "public"."phone_turn_role" AS ENUM('caller', 'assistant');--> statement-breakpoint
CREATE TABLE "phone_call_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"role" "phone_turn_role" NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"grounded_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_eur" numeric(10, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"call_sid" text NOT NULL,
	"caller_number" text,
	"language" text NOT NULL,
	"notice_at" timestamp with time zone,
	"outcome" "phone_call_outcome",
	"turns" integer DEFAULT 0 NOT NULL,
	"silences" integer DEFAULT 0 NOT NULL,
	"cost_eur" numeric(10, 6) DEFAULT '0' NOT NULL,
	"reserved_eur" numeric(10, 6) DEFAULT '0' NOT NULL,
	"message" text,
	"duration_seconds" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "phone_calls_message_after_notice" CHECK ("phone_calls"."message" IS NULL OR "phone_calls"."notice_at" IS NOT NULL),
	CONSTRAINT "phone_calls_message_outcome" CHECK ("phone_calls"."outcome" IS DISTINCT FROM 'message' OR "phone_calls"."message" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "phone_settings" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"phone_number" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"handover_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_settings_number_e164" CHECK ("phone_settings"."phone_number" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "phone_settings_handover_e164" CHECK ("phone_settings"."handover_number" IS NULL OR "phone_settings"."handover_number" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
ALTER TABLE "phone_call_turns" ADD CONSTRAINT "phone_call_turns_call_id_phone_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."phone_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_settings" ADD CONSTRAINT "phone_settings_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_settings" ADD CONSTRAINT "phone_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_call_turns_call_idx" ON "phone_call_turns" USING btree ("call_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_sid_idx" ON "phone_calls" USING btree ("call_sid");--> statement-breakpoint
CREATE INDEX "phone_calls_profile_idx" ON "phone_calls" USING btree ("profile_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_settings_number_idx" ON "phone_settings" USING btree ("phone_number");