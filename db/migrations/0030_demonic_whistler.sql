CREATE TYPE "public"."connection_purpose" AS ENUM('measure', 'execute');--> statement-breakpoint
DROP INDEX "connections_active_idx";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "purpose" "connection_purpose" DEFAULT 'measure' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_active_idx" ON "connections" USING btree ("account_id","provider","purpose") WHERE status <> 'disconnected';--> statement-breakpoint
-- P3-20b (rule 13, Session D layer D0): a MEASURE connection can never hold
-- a write-capable scope. The pattern list mirrors WRITE_CAPABLE in
-- lib/connectors/scopes.ts (isWriteCapable); lib/execution/connections.test.ts
-- proves the two agree on a sample, both directions. A BEFORE trigger, not
-- a CHECK, because a CHECK cannot iterate a jsonb array and because it must
-- bind the table owner too (the decision-log precedent, migration 0010).
CREATE FUNCTION connections_measure_rows_read_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  IF NEW.purpose = 'measure' THEN
    FOR s IN SELECT jsonb_array_elements_text(NEW.granted_scopes) LOOP
      IF s ~* '(write|manage|admin|delete|create|update|modify|edit|publish|full[_.-]?access)'
         OR s = '*'
         OR s ~* '^all$' THEN
        RAISE EXCEPTION 'connections: a measurement connection cannot hold the write-capable scope "%"', s
          USING ERRCODE = 'check_violation',
                HINT = 'Write access is its own consent (rule 13). Connect it through lib/execution/connections with purpose = execute.';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER connections_measure_rows_read_only
  BEFORE INSERT OR UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION connections_measure_rows_read_only();
