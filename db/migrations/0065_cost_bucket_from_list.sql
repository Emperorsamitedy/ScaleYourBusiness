-- Refile the cost rows entered on 5.2 ("costs go up when you sell more").
-- Until 2026-10-28 the intake filed every cost row under the "fixed"
-- bucket, so unit economics counted per-sale costs among the monthly ones.
-- Which list a row was entered on is the current 5.2 answer's own
-- entity_ids; those rows become variable and scale with sales. The bucket
-- is a spine column (structural membership, data model §5.5), not a fact,
-- so this corrects structure and supersedes nothing. Snapshots already
-- taken keep the kind they froze.
UPDATE "cost_items"
SET "bucket" = 'variable', "scales_with_sales" = true
WHERE "bucket" = 'fixed'
  AND "id"::text IN (
    SELECT jsonb_array_elements_text("value" -> 'entity_ids')
    FROM "field_records"
    WHERE "field_key" = 'costs.variable'
      AND "superseded_at" IS NULL
      AND jsonb_typeof("value" -> 'entity_ids') = 'array'
  );
