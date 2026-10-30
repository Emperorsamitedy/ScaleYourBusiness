-- Idea 45, review 2026-10-30: the code and link from Gmail's forwarding
-- confirmation to a business's reviews address, and when it came, for
-- /reviews to show. Nothing else of that mail. Additive, nullable, forward-only.
ALTER TABLE "review_settings" ADD COLUMN "gmail_confirmation" jsonb;
