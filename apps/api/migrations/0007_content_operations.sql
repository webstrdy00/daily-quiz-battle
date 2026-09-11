ALTER TABLE question_revisions
  ADD COLUMN time_sensitive boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT question_revisions_choices_ck,
  ADD CONSTRAINT question_revisions_choices_ck CHECK (
    jsonb_typeof(choices) = 'array'
    AND jsonb_array_length(choices) = 4
    AND jsonb_typeof(choices -> 0) = 'string'
    AND char_length(btrim(choices ->> 0)) > 0
    AND jsonb_typeof(choices -> 1) = 'string'
    AND char_length(btrim(choices ->> 1)) > 0
    AND jsonb_typeof(choices -> 2) = 'string'
    AND char_length(btrim(choices ->> 2)) > 0
    AND jsonb_typeof(choices -> 3) = 'string'
    AND char_length(btrim(choices ->> 3)) > 0
  ),
  ADD CONSTRAINT question_revisions_time_sensitive_ck CHECK (
    NOT time_sensitive
    OR (
      valid_until IS NOT NULL
      AND next_review_at IS NOT NULL
      AND valid_until > source_checked_at
    )
  ),
  ADD CONSTRAINT question_revisions_published_at_ck CHECK (
    lifecycle_status <> 'published' OR published_at IS NOT NULL
  ),
  ADD CONSTRAINT question_revisions_retired_at_ck CHECK (
    lifecycle_status <> 'retired' OR retired_at IS NOT NULL
  );

CREATE OR REPLACE FUNCTION enforce_question_revision_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle_status IN ('published', 'retired') AND (
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
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
  ) THEN
    RAISE EXCEPTION 'published question revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_question_revision_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle_status = NEW.lifecycle_status THEN
    RETURN NEW;
  END IF;

  IF
    (OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status = 'review')
    OR (OLD.lifecycle_status = 'review' AND NEW.lifecycle_status IN ('draft', 'approved'))
    OR (OLD.lifecycle_status = 'approved' AND NEW.lifecycle_status IN ('draft', 'published'))
    OR (OLD.lifecycle_status = 'published' AND NEW.lifecycle_status = 'retired')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'question revision status transition is not allowed';
END;
$$;

CREATE TRIGGER question_revisions_status_transition_trg
BEFORE UPDATE OF lifecycle_status ON question_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_question_revision_status_transition();

CREATE TABLE admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_subject varchar(100) NOT NULL,
  action varchar(64) NOT NULL,
  resource_type varchar(32) NOT NULL,
  resource_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_logs_metadata_object_ck CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX admin_audit_logs_resource_time_idx
  ON admin_audit_logs (resource_type, resource_id, created_at DESC);
