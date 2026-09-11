ALTER TYPE "public"."intake_event_kind" ADD VALUE 'funnel_intake_started';--> statement-breakpoint
ALTER TYPE "public"."intake_event_kind" ADD VALUE 'funnel_core_completed';--> statement-breakpoint
ALTER TYPE "public"."intake_event_kind" ADD VALUE 'funnel_report_delivered';--> statement-breakpoint
ALTER TYPE "public"."intake_event_kind" ADD VALUE 'funnel_recommendation_response';--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"workload" text NOT NULL,
	"model" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_input_tokens" integer NOT NULL,
	"cache_read_input_tokens" integer NOT NULL,
	"cost_eur" numeric(10, 6) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_calls_account_at_idx" ON "llm_calls" USING btree ("account_id","at");