ALTER TYPE "public"."decision_kind" ADD VALUE 'team_invite';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'team_invite_revoke';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'team_join';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'team_role';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'team_remove';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'account_switch';--> statement-breakpoint
CREATE TABLE "team_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "team_invites_expiry_after_creation" CHECK ("team_invites"."expires_at" > "team_invites"."created_at"),
	CONSTRAINT "team_invites_accepted_or_revoked" CHECK ("team_invites"."accepted_at" IS NULL OR "team_invites"."revoked_at" IS NULL)
);
--> statement-breakpoint
DROP INDEX "users_email_idx";--> statement-breakpoint
ALTER TABLE "decision_log" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN "invite_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invites_hash_idx" ON "team_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "team_invites_open_idx" ON "team_invites" USING btree ("account_id","email") WHERE "team_invites"."accepted_at" IS NULL AND "team_invites"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_invite_id_team_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."team_invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_email_idx" ON "users" USING btree ("account_id","email");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
-- Idea 52: an account with anyone on it always keeps at least one owner
-- (an active users row with role 'owner'), held by the database so no
-- route, script or race can leave a business without one. A DEFERRED
-- constraint trigger, checked at commit: an owner can hand over (promote
-- a teammate, then step down) inside one transaction, and deleting an
-- account's every row together (an account going away) passes, because a
-- business with nobody on it has no one to be owner of.
--
-- The account row is locked (FOR NO KEY UPDATE, which foreign-key checks
-- don't wait on) before counting, so two owners demoting each other at the
-- same moment serialise: the second to commit sees the first and fails.
CREATE FUNCTION users_keep_an_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct uuid;
BEGIN
  FOR acct IN
    SELECT DISTINCT a FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.account_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.account_id END
    ]) AS a WHERE a IS NOT NULL
  LOOP
    PERFORM 1 FROM accounts WHERE id = acct FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM users WHERE account_id = acct)
       AND NOT EXISTS (
         SELECT 1 FROM users
         WHERE account_id = acct AND role = 'owner' AND removed_at IS NULL
       ) THEN
      RAISE EXCEPTION 'an account always keeps at least one owner'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'users_keep_an_owner',
              HINT = 'Make someone else an owner first.';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER users_keep_an_owner
  AFTER INSERT OR UPDATE OR DELETE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_keep_an_owner();
