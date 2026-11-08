-- TikTok posting (owner override 2026-11-08, TASKS-PHASE3.md P3-21): the settings the owner
-- chose for one TikTok post before approving it — privacy picked by hand from TikTok's own
-- options, comments/duets/stitches and "your brand" off unless turned on. Additive; null for
-- every existing item and every Meta post.
ALTER TABLE "content_items" ADD COLUMN "tiktok_settings" jsonb;
