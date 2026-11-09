-- P6-05, the owner's decisions of 2026-11-09: each downloaded bank file is an export batch (its MsgId, moment, who, the "pay from" statement it used), and a payment is in one file at most, so a repeated download can't pay twice.
CREATE TABLE "payment_export_items" (
	"export_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"format" text NOT NULL,
	"msg_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"made_on" date NOT NULL,
	"created_by" uuid,
	"payer_account_id" uuid,
	"locale" text NOT NULL,
	"nb_of_txs" integer NOT NULL,
	"ctrl_sum_minor" bigint,
	"sha256" text NOT NULL,
	CONSTRAINT "payment_exports_format" CHECK ("payment_exports"."format" IN ('sepa', 'steps')),
	CONSTRAINT "payment_exports_sepa_has_payer" CHECK ("payment_exports"."format" <> 'sepa' OR "payment_exports"."payer_account_id" IS NOT NULL),
	CONSTRAINT "payment_exports_count" CHECK ("payment_exports"."nb_of_txs" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_export_items" ADD CONSTRAINT "payment_export_items_export_id_payment_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."payment_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_export_items" ADD CONSTRAINT "payment_export_items_payment_id_prepared_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."prepared_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_exports" ADD CONSTRAINT "payment_exports_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_exports" ADD CONSTRAINT "payment_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_exports" ADD CONSTRAINT "payment_exports_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_export_items_payment_idx" ON "payment_export_items" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_export_items_position_idx" ON "payment_export_items" USING btree ("export_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_exports_msg_id_idx" ON "payment_exports" USING btree ("msg_id");--> statement-breakpoint
CREATE INDEX "payment_exports_profile_idx" ON "payment_exports" USING btree ("profile_id","created_at");