-- The v1 build spec, Phase 0 (P7-31, P7-32): what the database itself enforces.
--
-- 1. figures (§6.1, hard rule 3). A derived figure's grade is the LOWEST of
--    the figures it depends on, capped at C when modelled — checked here, at
--    insert, against the stored inputs, so no caller can launder a grade.
--    Every input must exist and belong to the same business. A measured
--    figure graded A names its cross-check: another measured figure of the
--    same business. Figures are never edited (a new reading is a new
--    figure); DELETE stays open so erasure cascades with the business.
--
-- 2. country_compliance_matrix (§9.2, §9.5). Every insert, update and
--    delete must name who made it (SET LOCAL syb.actor) and is copied, before
--    and after, into country_compliance_changes, which is append-only. A
--    TRUNCATE would bypass the row trigger, so it is refused.
--
-- Same reasoning as decision_log (migration 0010) and proof_ledger (0098):
-- triggers bind the table owner, REVOKE does not.

CREATE FUNCTION figures_grade_inherits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  found_count integer;
  worst text;
  expected text;
  check_row record;
BEGIN
  IF NEW.source = 'derived' THEN
    SELECT count(*), max(f.confidence)
      INTO found_count, worst
      FROM figures f
     WHERE f.id = ANY (NEW.depends_on)
       AND f.profile_id = NEW.profile_id;
    IF found_count <> (SELECT count(DISTINCT d) FROM unnest(NEW.depends_on) AS d) THEN
      RAISE EXCEPTION 'figure % depends on a figure that does not exist for this business', NEW.key
        USING ERRCODE = 'raise_exception';
    END IF;
    -- Letters sort A < B < C < D, so the greatest is the worst grade.
    expected := CASE WHEN NEW.modelled THEN greatest(worst, 'C') ELSE worst END;
    IF NEW.confidence <> expected THEN
      RAISE EXCEPTION 'figure % is graded % but its inputs make it % (hard rule 3: grades never launder)',
        NEW.key, NEW.confidence, expected
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF NEW.source = 'measured' AND NEW.cross_check_id IS NOT NULL THEN
    SELECT f.source, f.profile_id INTO check_row FROM figures f WHERE f.id = NEW.cross_check_id;
    IF NOT FOUND OR check_row.profile_id <> NEW.profile_id OR check_row.source <> 'measured'
       OR NEW.cross_check_id = NEW.id THEN
      RAISE EXCEPTION 'figure % is graded A, but its cross-check is not another measured figure of this business', NEW.key
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER figures_grade_inherits
  BEFORE INSERT ON figures
  FOR EACH ROW EXECUTE FUNCTION figures_grade_inherits();
--> statement-breakpoint
CREATE FUNCTION figures_never_edited() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'figures are never edited: record a new figure instead'
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER figures_no_update
  BEFORE UPDATE ON figures
  FOR EACH ROW EXECUTE FUNCTION figures_never_edited();
--> statement-breakpoint
CREATE FUNCTION country_compliance_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(trim(current_setting('syb.actor', true)), '') = '' THEN
    RAISE EXCEPTION 'every change to the country compliance matrix names who made it (syb.actor)'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER country_compliance_matrix_actor
  BEFORE INSERT OR UPDATE OR DELETE ON country_compliance_matrix
  FOR EACH ROW EXECUTE FUNCTION country_compliance_actor();
--> statement-breakpoint
CREATE FUNCTION country_compliance_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO country_compliance_changes (country, op, before, after, actor, reason)
  VALUES (
    coalesce(NEW.country, OLD.country),
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    current_setting('syb.actor', true),
    nullif(current_setting('syb.reason', true), '')
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER country_compliance_matrix_audit
  AFTER INSERT OR UPDATE OR DELETE ON country_compliance_matrix
  FOR EACH ROW EXECUTE FUNCTION country_compliance_audit();
--> statement-breakpoint
CREATE FUNCTION country_compliance_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: it would skip the audit log', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER country_compliance_matrix_no_truncate
  BEFORE TRUNCATE ON country_compliance_matrix
  FOR EACH STATEMENT EXECUTE FUNCTION country_compliance_no_truncate();
--> statement-breakpoint
CREATE FUNCTION country_compliance_changes_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'country_compliance_changes is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER country_compliance_changes_no_update_delete
  BEFORE UPDATE OR DELETE ON country_compliance_changes
  FOR EACH ROW EXECUTE FUNCTION country_compliance_changes_append_only();
--> statement-breakpoint
CREATE TRIGGER country_compliance_changes_no_truncate
  BEFORE TRUNCATE ON country_compliance_changes
  FOR EACH STATEMENT EXECUTE FUNCTION country_compliance_changes_append_only();
