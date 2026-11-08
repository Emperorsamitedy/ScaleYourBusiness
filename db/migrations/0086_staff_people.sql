-- P6-06 (rule 28 amended): what the owner states about a person (their weekly capacity), and the keyed hashes of people a removal erased (rule 22).
CREATE TABLE "staff_erasures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"staff_key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"staff_ref" text NOT NULL,
	"capacity_per_week" integer,
	"capacity_stated_at" timestamp with time zone,
	"capacity_stated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_people_capacity_sane" CHECK ("staff_people"."capacity_per_week" IS NULL OR ("staff_people"."capacity_per_week" > 0 AND "staff_people"."capacity_per_week" <= 1000)),
	CONSTRAINT "staff_people_capacity_stated" CHECK (("staff_people"."capacity_per_week" IS NULL) = ("staff_people"."capacity_stated_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "staff_erasures" ADD CONSTRAINT "staff_erasures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_people" ADD CONSTRAINT "staff_people_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_erasures_idx" ON "staff_erasures" USING btree ("account_id","staff_key");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_people_ref_idx" ON "staff_people" USING btree ("account_id","staff_ref");