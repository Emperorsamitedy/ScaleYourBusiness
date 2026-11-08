-- P6-05 (rule 26 amended): prepared payments. The owner's own "pay from" details as a stated fact
-- (superseded, never overwritten) and the payments SYB prepares for the owner's own bank. No column
-- holds a bank credential; payee IBANs are erasable (rule 22).
CREATE TABLE "payer_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"holder_name" text NOT NULL,
	"iban" text NOT NULL,
	"bic" text,
	"status" "field_status" DEFAULT 'answered' NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"source" jsonb NOT NULL,
	"stated_by" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	CONSTRAINT "payer_accounts_iban_shape" CHECK ("payer_accounts"."iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$')
);
--> statement-breakpoint
CREATE TABLE "prepared_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"payee_name" text,
	"payee_iban" text,
	"payee_bic" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"reference" text NOT NULL,
	"execution_date" date NOT NULL,
	"pays_kind" text NOT NULL,
	"supplier_id" uuid,
	"cost_item_id" uuid,
	"purchase_order_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_stated_at" timestamp with time zone,
	"paid_stated_by" uuid,
	"erased_at" timestamp with time zone,
	CONSTRAINT "prepared_payments_amount_positive" CHECK ("prepared_payments"."amount_minor" > 0),
	CONSTRAINT "prepared_payments_currency_shape" CHECK ("prepared_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "prepared_payments_pays_kind" CHECK ("prepared_payments"."pays_kind" IN ('supplier', 'fixed_cost', 'purchase_order', 'other')),
	CONSTRAINT "prepared_payments_payee_or_erased" CHECK ("prepared_payments"."erased_at" IS NOT NULL OR ("prepared_payments"."payee_name" IS NOT NULL AND "prepared_payments"."payee_iban" IS NOT NULL)),
	CONSTRAINT "prepared_payments_erased_holds_nothing" CHECK ("prepared_payments"."erased_at" IS NULL OR ("prepared_payments"."payee_name" IS NULL AND "prepared_payments"."payee_iban" IS NULL AND "prepared_payments"."payee_bic" IS NULL)),
	CONSTRAINT "prepared_payments_paid_by_someone" CHECK (("prepared_payments"."paid_stated_at" IS NULL) = ("prepared_payments"."paid_stated_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payer_accounts" ADD CONSTRAINT "payer_accounts_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_accounts" ADD CONSTRAINT "payer_accounts_stated_by_users_id_fk" FOREIGN KEY ("stated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_accounts" ADD CONSTRAINT "payer_accounts_superseded_by_payer_accounts_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_payments" ADD CONSTRAINT "prepared_payments_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_payments" ADD CONSTRAINT "prepared_payments_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_payments" ADD CONSTRAINT "prepared_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_payments" ADD CONSTRAINT "prepared_payments_cost_item_id_cost_items_id_fk" FOREIGN KEY ("cost_item_id") REFERENCES "public"."cost_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_payments" ADD CONSTRAINT "prepared_payments_paid_stated_by_users_id_fk" FOREIGN KEY ("paid_stated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_accounts_current_idx" ON "payer_accounts" USING btree ("profile_id") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prepared_payments_proposal_idx" ON "prepared_payments" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "prepared_payments_profile_idx" ON "prepared_payments" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "prepared_payments_supplier_idx" ON "prepared_payments" USING btree ("supplier_id");