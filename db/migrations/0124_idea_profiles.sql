ALTER TYPE "public"."decision_kind" ADD VALUE 'idea_saved';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'idea_test_result';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'idea_launch';--> statement-breakpoint
CREATE TABLE "idea_test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"idea_check_id" uuid NOT NULL,
	"observed" bigint NOT NULL,
	"reading" text NOT NULL,
	"note" text,
	"user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idea_test_results_reading" CHECK ("idea_test_results"."reading" in ('pass', 'fail', 'between')),
	CONSTRAINT "idea_test_results_observed" CHECK ("idea_test_results"."observed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "kind" text DEFAULT 'operating' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "launched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "idea_checks" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "idea_test_results" ADD CONSTRAINT "idea_test_results_idea_check_id_idea_checks_id_fk" FOREIGN KEY ("idea_check_id") REFERENCES "public"."idea_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idea_test_results_profile" ON "idea_test_results" USING btree ("profile_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_checks_profile" ON "idea_checks" USING btree ("profile_id") WHERE "idea_checks"."profile_id" is not null;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_kind_known" CHECK ("business_profiles"."kind" in ('operating', 'idea'));--> statement-breakpoint
-- TASKS-IDEAS.md I-10, rule 40: an idea has no connection, no proposal and
-- no execution — nothing is committed on a person's behalf before the
-- business exists. Held here so that no route, script or future connector
-- (there are several ways a connection is made) can get round it.
CREATE FUNCTION idea_refuses_operations() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  IF TG_TABLE_NAME = 'connections' THEN
    SELECT kind INTO k FROM business_profiles WHERE account_id = NEW.account_id;
  ELSE
    SELECT kind INTO k FROM business_profiles WHERE id = NEW.profile_id;
  END IF;
  IF k = 'idea' THEN
    RAISE EXCEPTION 'an idea has no % yet: launch it first (rule 40)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER connections_not_for_ideas BEFORE INSERT ON "connections"
  FOR EACH ROW EXECUTE FUNCTION idea_refuses_operations();
--> statement-breakpoint
CREATE TRIGGER proposals_not_for_ideas BEFORE INSERT ON "proposals"
  FOR EACH ROW EXECUTE FUNCTION idea_refuses_operations();
--> statement-breakpoint
CREATE TRIGGER executions_not_for_ideas BEFORE INSERT ON "executions"
  FOR EACH ROW EXECUTE FUNCTION idea_refuses_operations();
--> statement-breakpoint
-- I-50: launching is one way. An operating business never becomes an idea,
-- and a launched one keeps its launch date.
CREATE FUNCTION business_kind_one_way() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'operating' AND NEW.kind = 'idea' THEN
    RAISE EXCEPTION 'an operating business can''t become an idea' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.launched_at IS NOT NULL AND NEW.launched_at IS DISTINCT FROM OLD.launched_at THEN
    RAISE EXCEPTION 'a launch date is kept as it was' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER business_profiles_kind_one_way BEFORE UPDATE ON "business_profiles"
  FOR EACH ROW EXECUTE FUNCTION business_kind_one_way();
--> statement-breakpoint
-- I-32: a recorded result is kept as it was; a later result is a new row.
CREATE FUNCTION idea_test_results_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'idea_test_results is append-only' USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER idea_test_results_no_change BEFORE UPDATE OR DELETE ON "idea_test_results"
  FOR EACH ROW EXECUTE FUNCTION idea_test_results_append_only();
