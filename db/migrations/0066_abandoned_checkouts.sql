CREATE TABLE "abandoned_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"checkout_ref" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"completed_at" timestamp with time zone,
	"total_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lines_truncated" boolean DEFAULT false NOT NULL,
	"email_hash" text,
	"accepts_marketing" boolean,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "abandoned_checkouts_total_nonneg" CHECK ("abandoned_checkouts"."total_minor" >= 0),
	CONSTRAINT "abandoned_checkouts_currency" CHECK ("abandoned_checkouts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "abandoned_checkouts" ADD CONSTRAINT "abandoned_checkouts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abandoned_checkouts" ADD CONSTRAINT "abandoned_checkouts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abandoned_checkouts_ref_idx" ON "abandoned_checkouts" USING btree ("connection_id","checkout_ref");--> statement-breakpoint
CREATE INDEX "abandoned_checkouts_day_idx" ON "abandoned_checkouts" USING btree ("connection_id","day");--> statement-breakpoint
CREATE INDEX "abandoned_checkouts_hash_idx" ON "abandoned_checkouts" USING btree ("account_id","email_hash");