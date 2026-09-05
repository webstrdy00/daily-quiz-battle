DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM question_revisions
    WHERE (valid_until IS NULL) <> (next_review_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'question revisions with partial temporal metadata require explicit remediation';
  END IF;
END;
$$;

ALTER TABLE question_revisions
  DISABLE TRIGGER question_revisions_immutable_trg;

UPDATE question_revisions
SET time_sensitive = true
WHERE valid_until IS NOT NULL
  AND next_review_at IS NOT NULL
  AND NOT time_sensitive;

UPDATE question_revisions
SET category = lower(btrim(category))
WHERE category IS DISTINCT FROM lower(btrim(category));

ALTER TABLE question_revisions
  ENABLE TRIGGER question_revisions_immutable_trg;

ALTER TABLE question_revisions
  ADD CONSTRAINT question_revisions_category_canonical_ck CHECK (
    char_length(category) > 0
    AND category = lower(btrim(category))
  );

CREATE OR REPLACE FUNCTION enforce_question_revision_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.lifecycle_status IN ('published', 'retired')
    OR NEW.lifecycle_status IN ('published', 'retired')
  ) AND (
    NEW.question_id IS DISTINCT FROM OLD.question_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.difficulty IS DISTINCT FROM OLD.difficulty
    OR NEW.prompt IS DISTINCT FROM OLD.prompt
    OR NEW.choices IS DISTINCT FROM OLD.choices
    OR NEW.correct_index IS DISTINCT FROM OLD.correct_index
    OR NEW.explanation IS DISTINCT FROM OLD.explanation
    OR NEW.source_url IS DISTINCT FROM OLD.source_url
    OR NEW.source_checked_at IS DISTINCT FROM OLD.source_checked_at
    OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
    OR NEW.time_sensitive IS DISTINCT FROM OLD.time_sensitive
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.next_review_at IS DISTINCT FROM OLD.next_review_at
  ) THEN
    RAISE EXCEPTION 'published question revisions are immutable';
  END IF;

  IF OLD.lifecycle_status = 'approved'
    AND NEW.lifecycle_status = 'published'
  THEN
    IF OLD.published_at IS NOT NULL OR NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'published_at must be set when publishing an approved question revision';
    END IF;
  ELSIF NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published_at can only be set when publishing an approved question revision';
  END IF;

  IF OLD.lifecycle_status = 'published'
    AND NEW.lifecycle_status = 'retired'
  THEN
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
      RAISE EXCEPTION 'retired_at must be set when retiring a published question revision';
    END IF;
  ELSIF NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'retired_at can only be set when retiring a published question revision';
  END IF;

  RETURN NEW;
END;
$$;
