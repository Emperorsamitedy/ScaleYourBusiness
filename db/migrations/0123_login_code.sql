-- 2026-11-16: the 6-digit sign-in code (lib/auth/service codeHash). IF NOT EXISTS:
-- a local database that ran this change under its first number (0122) keeps working.
ALTER TABLE "login_tokens" ADD COLUMN IF NOT EXISTS "code_hash" text;
