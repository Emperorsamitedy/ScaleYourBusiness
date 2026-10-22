CREATE TYPE "public"."booking_status" AS ENUM('completed', 'no_show', 'cancelled_late', 'cancelled', 'booked_future');--> statement-breakpoint
CREATE TABLE "booking_appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source_ref" text NOT NULL,
	"batch_id" uuid,
	"day" date NOT NULL,
	"start_time" text,
	"status" "booking_status" NOT NULL,
	"service" text,
	"staff_ref" text,
	"client_key" text,
	"duration_minutes" integer,
	"price_minor" bigint,
	"currency" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_appointments_money_whole" CHECK (("booking_appointments"."price_minor" IS NULL) = ("booking_appointments"."currency" IS NULL)),
	CONSTRAINT "booking_appointments_duration_sane" CHECK ("booking_appointments"."duration_minutes" IS NULL OR ("booking_appointments"."duration_minutes" >= 0 AND "booking_appointments"."duration_minutes" <= 1440))
);
--> statement-breakpoint
CREATE TABLE "booking_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"currency" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rows_read" integer NOT NULL,
	"added" integer NOT NULL,
	"updated" integer NOT NULL,
	"unchanged" integer NOT NULL,
	"skipped" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"columns" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_appointments" ADD CONSTRAINT "booking_appointments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_appointments" ADD CONSTRAINT "booking_appointments_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_appointments" ADD CONSTRAINT "booking_appointments_batch_id_booking_imports_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."booking_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_imports" ADD CONSTRAINT "booking_imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_imports" ADD CONSTRAINT "booking_imports_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_appointments_source_idx" ON "booking_appointments" USING btree ("connection_id","source_ref");--> statement-breakpoint
CREATE INDEX "booking_appointments_day_idx" ON "booking_appointments" USING btree ("connection_id","day");--> statement-breakpoint
CREATE INDEX "booking_appointments_client_idx" ON "booking_appointments" USING btree ("account_id","client_key") WHERE client_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "booking_imports_account_idx" ON "booking_imports" USING btree ("account_id","imported_at");