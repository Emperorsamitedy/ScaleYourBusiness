-- Append-only enforcement for decision_log (rule 7, step 17).
--
-- A BEFORE trigger that RAISEs, deliberately NOT `REVOKE UPDATE, DELETE`:
-- REVOKE does not restrict the table owner, and migrations (plus most app
-- connections in development) run as owner — permission-based protection
-- would be absent exactly where it counts. A trigger binds everyone,
-- owner included. Removing this protection requires a migration that
-- drops the trigger — visible in review and in the migration journal.

CREATE FUNCTION decision_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'decision_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception',
          HINT = 'The decision log is the audit trail. Write a new entry instead.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER decision_log_no_update_delete
  BEFORE UPDATE OR DELETE ON decision_log
  FOR EACH ROW EXECUTE FUNCTION decision_log_append_only();
--> statement-breakpoint
-- TRUNCATE bypasses row-level triggers; block it at statement level too.
CREATE TRIGGER decision_log_no_truncate
  BEFORE TRUNCATE ON decision_log
  FOR EACH STATEMENT EXECUTE FUNCTION decision_log_append_only();
