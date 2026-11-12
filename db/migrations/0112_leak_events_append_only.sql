-- The open leak register's history (the v1 build spec §6.4): every move of a
-- leak is a leak_events row, and nothing edits one. DELETE stays open so a
-- business's erasure cascades. Same trigger pattern as decision_log (0010).

CREATE FUNCTION leak_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'leak_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER leak_events_no_update
  BEFORE UPDATE ON leak_events
  FOR EACH ROW EXECUTE FUNCTION leak_events_append_only();
