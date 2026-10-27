CREATE TABLE "order_baskets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"order_ref" text NOT NULL,
	"day" date NOT NULL,
	"product_refs" text[] NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_baskets_not_empty" CHECK (cardinality("order_baskets"."product_refs") >= 1)
);
--> statement-breakpoint
ALTER TABLE "order_baskets" ADD CONSTRAINT "order_baskets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_baskets" ADD CONSTRAINT "order_baskets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_baskets_order_idx" ON "order_baskets" USING btree ("connection_id","order_ref");--> statement-breakpoint
CREATE INDEX "order_baskets_day_idx" ON "order_baskets" USING btree ("connection_id","day");