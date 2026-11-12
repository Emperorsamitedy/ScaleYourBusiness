-- The guarantee's evaluations (the v1 build spec §8.4) are an audit record:
-- nothing edits one. DELETE stays open so a business's erasure cascades.
-- Same trigger pattern as decision_log (0010) and leak_events (0112).

CREATE FUNCTION guarantee_evaluations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'guarantee_evaluations is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guarantee_evaluations_no_update
  BEFORE UPDATE ON guarantee_evaluations
  FOR EACH ROW EXECUTE FUNCTION guarantee_evaluations_append_only();
