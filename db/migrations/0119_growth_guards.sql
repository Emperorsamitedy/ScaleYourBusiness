-- The growth engine's rules (the v1 build spec §10.6), held by the database.
--
-- 1. "A brief that cannot cite evidence does not generate." Every figure id a
--    brief cites must be one of this business's §6.1 figures; and a new
--    generation must name a brief, and that brief must cite at least one.
-- 2. "Every rendered asset has a labelling_record before it can be
--    published." An AI-generated content item can't be queued, publishing
--    or published unless a labelling record covers its media.

CREATE FUNCTION creative_briefs_evidence_is_figures() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.evidence) AS e(id)
    WHERE NOT EXISTS (SELECT 1 FROM figures f WHERE f.id = e.id AND f.profile_id = NEW.profile_id)
  ) THEN
    RAISE EXCEPTION 'a brief cites only this business''s own figures'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creative_briefs_evidence_is_figures
  BEFORE INSERT OR UPDATE OF evidence ON creative_briefs
  FOR EACH ROW EXECUTE FUNCTION creative_briefs_evidence_is_figures();
--> statement-breakpoint
-- New rows only: generations from before this rule stay as they were.
ALTER TABLE media_generations
  ADD CONSTRAINT media_generations_needs_brief CHECK (creative_brief_id IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE media_generations
  ADD CONSTRAINT media_generations_brief_fk FOREIGN KEY (creative_brief_id)
  REFERENCES creative_briefs (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
CREATE FUNCTION media_generations_brief_has_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM creative_briefs b
    WHERE b.id = NEW.creative_brief_id
      AND b.profile_id = NEW.profile_id
      AND cardinality(b.evidence) > 0
  ) THEN
    RAISE EXCEPTION 'a brief that cannot cite evidence does not generate'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER media_generations_brief_has_evidence
  BEFORE INSERT ON media_generations
  FOR EACH ROW EXECUTE FUNCTION media_generations_brief_has_evidence();
--> statement-breakpoint
-- Every generated file was stamped at render since P3-53 (rule 17); its
-- record is written now for the items already made, from what they carry.
INSERT INTO labelling_records (profile_id, media_url, content_item_id, method, standard_version, label, labelled_at)
SELECT ci.profile_id,
       ci.media_path,
       ci.id,
       CASE WHEN ci.media_path ~* '\.jpe?g$' THEN 'iptc_xmp+jpeg_comment' ELSE 'mp4_comment' END,
       'IPTC Digital Source Type trainedAlgorithmicMedia; EU AI Act Art. 50(2) (backfilled from the render stamp)',
       ci.disclosure,
       ci.created_at
FROM content_items ci
WHERE ci.media_path IS NOT NULL
  AND (ci.provenance -> 'media' ->> 'is_ai_generated') = 'true';
--> statement-breakpoint
CREATE FUNCTION content_items_labelled() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('queued', 'publishing', 'published')
     AND NEW.media_path IS NOT NULL
     AND (NEW.provenance -> 'media' ->> 'is_ai_generated') = 'true'
     AND NOT EXISTS (
       SELECT 1 FROM labelling_records lr
       WHERE lr.content_item_id = NEW.id OR lr.media_url = NEW.media_path
     ) THEN
    RAISE EXCEPTION 'a generated asset is published only with its labelling record'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_items_labelled
  BEFORE INSERT OR UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION content_items_labelled();
