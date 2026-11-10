-- Append-only enforcement for proof_ledger and ladder_events
-- (architecture-v2 hard rule 2, invariant I2).
--
-- The same reasoning as decision_log (migration 0010): a BEFORE trigger that
-- RAISEs, not REVOKE — REVOKE does not bind the table owner, and migrations
-- and most app connections run as owner. A trigger binds everyone. A
-- correction is a new row naming the original, never an edit. Removing this
-- needs a migration that drops the trigger, visible in review.

CREATE FUNCTION proof_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'proof_ledger is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception',
          HINT = 'Write a correction entry naming the original instead.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER proof_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON proof_ledger
  FOR EACH ROW EXECUTE FUNCTION proof_ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER proof_ledger_no_truncate
  BEFORE TRUNCATE ON proof_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION proof_ledger_append_only();
--> statement-breakpoint
CREATE FUNCTION ladder_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ladder_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception',
          HINT = 'The ladder''s audit trail is written, never edited.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ladder_events_no_update_delete
  BEFORE UPDATE OR DELETE ON ladder_events
  FOR EACH ROW EXECUTE FUNCTION ladder_events_append_only();
--> statement-breakpoint
CREATE TRIGGER ladder_events_no_truncate
  BEFORE TRUNCATE ON ladder_events
  FOR EACH STATEMENT EXECUTE FUNCTION ladder_events_append_only();
