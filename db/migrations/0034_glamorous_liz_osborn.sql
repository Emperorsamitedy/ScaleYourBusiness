ALTER TABLE "contacts" ADD COLUMN "last_purchase_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "orders_count" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "total_spent_minor" bigint;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "spent_currency" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_spent_has_currency" CHECK (("contacts"."total_spent_minor" IS NULL) = ("contacts"."spent_currency" IS NULL));