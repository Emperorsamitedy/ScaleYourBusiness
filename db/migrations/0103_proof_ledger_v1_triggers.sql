-- The Proof Ledger in full — the v1 build spec §3.5 and §3.7 (P7-33..35).
--
-- 1. measurement_plans are immutable once opened. An UPDATE or DELETE is
--    not raised (a raise would roll back the record of the attempt with
--    it): the trigger writes the attempt to ledger_tamper_events and skips
--    the change. window_end can never move.
--
-- 2. ledger_entries are append-only: UPDATE, DELETE and TRUNCATE raise.
--    An insert must extend the chain: under the chain lock, its seq is the
--    head's seq + 1 and its prev_hash the head's entry_hash, or it is
--    refused — the chain can't fork, and an entry can't be slipped in
--    between two others. The hash itself is computed by lib/ledger/chain.ts
--    and re-checked by the verify endpoint, which walks every entry.
--
-- 3. ledger_tamper_events and ledger_chain_heads are append-only.
--
-- Same reasoning as decision_log (0010) and proof_ledger (0098): triggers
-- bind the table owner, REVOKE does not.

CREATE FUNCTION measurement_plans_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger_tamper_events (table_name, row_id, op, attempted, db_user)
  VALUES (
    'measurement_plans',
    OLD.id,
    TG_OP,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) ELSE NULL END,
    current_user
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER measurement_plans_no_edit
  BEFORE UPDATE OR DELETE ON measurement_plans
  FOR EACH ROW EXECUTE FUNCTION measurement_plans_immutable();
--> statement-breakpoint
CREATE FUNCTION ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception',
          HINT = 'A correction is a new entry naming the one it corrects.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER measurement_plans_no_truncate
  BEFORE TRUNCATE ON measurement_plans
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_tamper_events_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_tamper_events
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_tamper_events_no_truncate
  BEFORE TRUNCATE ON ledger_tamper_events
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_chain_heads_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_chain_heads
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_chain_heads_no_truncate
  BEFORE TRUNCATE ON ledger_chain_heads
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE FUNCTION ledger_entries_extend_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head record;
BEGIN
  -- The same lock lib/ledger/chain.ts takes before it reads the head.
  PERFORM pg_advisory_xact_lock(hashtext('syb_ledger_chain'));
  SELECT seq, entry_hash INTO head FROM ledger_entries ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.seq <> 1 OR NEW.prev_hash IS NOT NULL THEN
      RAISE EXCEPTION 'the first ledger entry starts the chain: seq 1, no prev_hash'
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF NEW.seq <> head.seq + 1 OR NEW.prev_hash IS DISTINCT FROM head.entry_hash THEN
    RAISE EXCEPTION 'a ledger entry must extend the chain head (seq %, hash %)', head.seq, head.entry_hash
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_extend_chain
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_extend_chain();
