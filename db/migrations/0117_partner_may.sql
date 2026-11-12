-- The v1 build spec §7.7: "No partner can read or act on a business without
-- an active, unexpired, unrevoked mandate — enforced at the data layer."
--
-- partner_may is the one test, in the database: a live member of a firm,
-- that firm's mandate for that business, not revoked, not expired, and the
-- scope in it. Every partner query in lib/partners puts it in its WHERE, so
-- a missing, expired or revoked mandate returns no rows at all, and a
-- revocation applies to the very next query.
CREATE FUNCTION partner_may(p_user uuid, p_profile uuid, p_scope text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM mandates m
    JOIN firm_members fm ON fm.firm_id = m.firm_id
    WHERE fm.user_id = p_user
      AND fm.removed_at IS NULL
      AND m.profile_id = p_profile
      AND m.revoked_at IS NULL
      AND m.expires_at > now()
      AND p_scope = ANY (m.scopes)
  )
$$;
--> statement-breakpoint
-- A granted mandate is a record: its firm, business, scopes, grantor,
-- term and evidence never change. The one change allowed is its
-- revocation, set once and never cleared — the audit trail stays intact.
-- DELETE stays open only so a business's erasure cascades.
CREATE FUNCTION mandates_revoke_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.firm_id IS DISTINCT FROM OLD.firm_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
                                         OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id)) THEN
    RAISE EXCEPTION 'a mandate only ever gets revoked: grant a new one to change it'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mandates_revoke_only
  BEFORE UPDATE ON mandates
  FOR EACH ROW EXECUTE FUNCTION mandates_revoke_only();
