CREATE TABLE "idea_test_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"visitor" text NOT NULL,
	"day" date NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idea_test_events_kind" CHECK ("idea_test_events"."kind" in ('visit', 'interest'))
);
--> statement-breakpoint
CREATE TABLE "idea_test_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"idea_check_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"pitch" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"min_visits" integer NOT NULL,
	"pass_rate_bp" integer NOT NULL,
	"fail_below_rate_bp" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idea_test_events" ADD CONSTRAINT "idea_test_events_page_id_idea_test_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."idea_test_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_test_pages" ADD CONSTRAINT "idea_test_pages_idea_check_id_idea_checks_id_fk" FOREIGN KEY ("idea_check_id") REFERENCES "public"."idea_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idea_test_events_once" ON "idea_test_events" USING btree ("page_id","kind","visitor","day");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_test_pages_slug" ON "idea_test_pages" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_test_pages_profile" ON "idea_test_pages" USING btree ("profile_id");--> statement-breakpoint
-- Gap 5: what a test page measured is kept as it was: a later visit is a new row.
CREATE FUNCTION idea_test_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'idea_test_events is append-only' USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER idea_test_events_no_change BEFORE UPDATE OR DELETE ON "idea_test_events"
  FOR EACH ROW EXECUTE FUNCTION idea_test_events_append_only();
