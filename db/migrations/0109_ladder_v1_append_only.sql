-- The Trust Ladder in full (the v1 build spec §4): what must not be rewritten.
--
-- limit_actions records what station 4 did inside the owner's caps; the
-- caps for the rest of the day are read from it, so it is append-only.
-- promotion_requests may only move forward: once confirmed or withdrawn, a
-- request is never reopened or edited, and its recorded evidence never
-- changes. Same trigger pattern as decision_log (0010) and proof_ledger (0098).

CREATE FUNCTION limit_actions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'limit_actions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER limit_actions_no_update
  BEFORE UPDATE ON limit_actions
  FOR EACH ROW EXECUTE FUNCTION limit_actions_append_only();
--> statement-breakpoint
CREATE FUNCTION promotion_requests_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.confirmed_at IS NOT NULL OR OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'a confirmed or withdrawn promotion request is final'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.eligibility IS DISTINCT FROM OLD.eligibility
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.to_station IS DISTINCT FROM OLD.to_station
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a promotion request''s evidence and window never change'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER promotion_requests_forward_only
  BEFORE UPDATE ON promotion_requests
  FOR EACH ROW EXECUTE FUNCTION promotion_requests_forward_only();
