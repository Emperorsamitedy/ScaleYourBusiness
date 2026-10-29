CREATE TABLE "forecast_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"forecast_key" text NOT NULL,
	"made_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject" text NOT NULL,
	"subject_ref" jsonb NOT NULL,
	"metric" text NOT NULL,
	"unit" text NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"low_minor" bigint,
	"high_minor" bigint,
	"currency" text,
	"low_num" numeric(18, 4),
	"high_num" numeric(18, 4),
	"low_date" date,
	"high_date" date,
	"claim" text NOT NULL,
	"basis" text NOT NULL,
	"graded_at" timestamp with time zone,
	"verdict" text,
	"actual_minor" bigint,
	"actual_num" numeric(18, 4),
	"actual_date" date,
	"actual_note" text,
	"actual_source" jsonb,
	CONSTRAINT "forecast_checks_kind" CHECK ("forecast_checks"."kind" IN ('stock_out', 'season_week')),
	CONSTRAINT "forecast_checks_unit" CHECK ("forecast_checks"."unit" IN ('money', 'count', 'date')),
	CONSTRAINT "forecast_checks_window" CHECK ("forecast_checks"."window_start" <= "forecast_checks"."window_end"),
	CONSTRAINT "forecast_checks_money" CHECK ("forecast_checks"."unit" <> 'money' OR ("forecast_checks"."low_minor" IS NOT NULL AND "forecast_checks"."high_minor" IS NOT NULL AND "forecast_checks"."low_minor" <= "forecast_checks"."high_minor" AND "forecast_checks"."currency" IS NOT NULL AND "forecast_checks"."currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "forecast_checks_count" CHECK ("forecast_checks"."unit" <> 'count' OR ("forecast_checks"."low_num" IS NOT NULL AND "forecast_checks"."high_num" IS NOT NULL AND "forecast_checks"."low_num" <= "forecast_checks"."high_num")),
	CONSTRAINT "forecast_checks_date" CHECK ("forecast_checks"."unit" <> 'date' OR ("forecast_checks"."low_date" IS NOT NULL AND "forecast_checks"."high_date" IS NOT NULL AND "forecast_checks"."low_date" <= "forecast_checks"."high_date")),
	CONSTRAINT "forecast_checks_verdict" CHECK ("forecast_checks"."verdict" IS NULL OR "forecast_checks"."verdict" IN ('inside', 'above', 'below', 'cant_tell')),
	CONSTRAINT "forecast_checks_graded_whole" CHECK (("forecast_checks"."graded_at" IS NULL) = ("forecast_checks"."verdict" IS NULL) AND ("forecast_checks"."graded_at" IS NULL) = ("forecast_checks"."actual_note" IS NULL)),
	CONSTRAINT "forecast_checks_actual_measured" CHECK ("forecast_checks"."verdict" IS NULL OR "forecast_checks"."verdict" = 'cant_tell' OR "forecast_checks"."actual_source" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "forecast_checks" ADD CONSTRAINT "forecast_checks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_checks" ADD CONSTRAINT "forecast_checks_profile_id_business_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_checks_key_idx" ON "forecast_checks" USING btree ("profile_id","forecast_key");--> statement-breakpoint
CREATE INDEX "forecast_checks_due_idx" ON "forecast_checks" USING btree ("window_end") WHERE "forecast_checks"."graded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "forecast_checks_profile_idx" ON "forecast_checks" USING btree ("profile_id","made_at");--> statement-breakpoint
-- Idea 54 (I-54.1): a forecast is recorded when it is made, and graded once.
--
-- BEFORE triggers that RAISE, in decision_log's style (0010): a trigger
-- binds the table owner too, so the protection holds where migrations and
-- most connections run. It refuses:
--   · a row inserted already graded: the grade comes later, from measured rows;
--   · any change to a claim — what was said, its range, its window, its basis;
--   · any second grading, and any update that isn't the grading;
--   · a delete on its own. A forecast leaves the record only with its
--     business: a delete reached through business_profiles' ON DELETE
--     CASCADE runs inside the foreign key's own trigger, so
--     pg_trigger_depth() is above 1 there and nowhere else;
--   · TRUNCATE, which bypasses row triggers.
CREATE FUNCTION forecast_checks_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'forecast_checks: TRUNCATE is not permitted'
      USING ERRCODE = 'raise_exception',
            HINT = 'The track record keeps every forecast with its grade.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'forecast_checks: a forecast is not deleted on its own'
      USING ERRCODE = 'raise_exception',
            HINT = 'A forecast leaves the record only with its business.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.graded_at IS NOT NULL OR NEW.verdict IS NOT NULL OR NEW.actual_minor IS NOT NULL
       OR NEW.actual_num IS NOT NULL OR NEW.actual_date IS NOT NULL
       OR NEW.actual_note IS NOT NULL OR NEW.actual_source IS NOT NULL THEN
      RAISE EXCEPTION 'forecast_checks: a forecast is recorded ungraded'
        USING ERRCODE = 'raise_exception',
              HINT = 'Its grade comes later, once, from measured rows.';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.graded_at IS NOT NULL THEN
    RAISE EXCEPTION 'forecast_checks: this forecast is already graded'
      USING ERRCODE = 'raise_exception',
            HINT = 'A grade is written once and never changed.';
  END IF;
  IF (NEW.id, NEW.account_id, NEW.profile_id, NEW.kind, NEW.forecast_key, NEW.made_at,
      NEW.recorded_at, NEW.subject, NEW.subject_ref, NEW.metric, NEW.unit,
      NEW.window_start, NEW.window_end, NEW.low_minor, NEW.high_minor, NEW.currency,
      NEW.low_num, NEW.high_num, NEW.low_date, NEW.high_date, NEW.claim, NEW.basis)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.profile_id, OLD.kind, OLD.forecast_key, OLD.made_at,
      OLD.recorded_at, OLD.subject, OLD.subject_ref, OLD.metric, OLD.unit,
      OLD.window_start, OLD.window_end, OLD.low_minor, OLD.high_minor, OLD.currency,
      OLD.low_num, OLD.high_num, OLD.low_date, OLD.high_date, OLD.claim, OLD.basis) THEN
    RAISE EXCEPTION 'forecast_checks: a forecast''s claim is never changed'
      USING ERRCODE = 'raise_exception',
            HINT = 'What was said stays as it was said.';
  END IF;
  IF NEW.graded_at IS NULL THEN
    RAISE EXCEPTION 'forecast_checks: the only change is the grading'
      USING ERRCODE = 'raise_exception',
            HINT = 'Set graded_at, the verdict and what happened together.';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forecast_checks_guard_rows
  BEFORE INSERT OR UPDATE OR DELETE ON forecast_checks
  FOR EACH ROW EXECUTE FUNCTION forecast_checks_guard();
--> statement-breakpoint
CREATE TRIGGER forecast_checks_no_truncate
  BEFORE TRUNCATE ON forecast_checks
  FOR EACH STATEMENT EXECUTE FUNCTION forecast_checks_guard();
