CREATE TYPE report_status AS ENUM (
  'open',
  'reviewing',
  'resolved',
  'dismissed'
);

ALTER TABLE reports
  ADD COLUMN status report_status,
  ADD COLUMN triaged_by varchar(100),
  ADD COLUMN triaged_at timestamptz;

UPDATE reports
SET status = 'open'
WHERE status IS NULL;

ALTER TABLE reports
  ALTER COLUMN status SET DEFAULT 'open',
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT reports_triage_fields_ck CHECK (
    (
      status = 'open'
      AND triaged_by IS NULL
      AND triaged_at IS NULL
    )
    OR (
      status <> 'open'
      AND triaged_by IS NOT NULL
      AND triaged_at IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION enforce_report_triage_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('resolved', 'dismissed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal reports are immutable';
  END IF;

  IF
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id
    OR NEW.question_revision_id IS DISTINCT FROM OLD.question_revision_id
    OR NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.detail IS DISTINCT FROM OLD.detail
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.dedupe_window_start IS DISTINCT FROM OLD.dedupe_window_start
  THEN
    RAISE EXCEPTION 'report core columns are immutable';
  END IF;

  IF OLD.status = NEW.status THEN
    IF
      NEW.triaged_by IS DISTINCT FROM OLD.triaged_by
      OR NEW.triaged_at IS DISTINCT FROM OLD.triaged_at
    THEN
      RAISE EXCEPTION 'report triage fields can only change with status';
    END IF;

    RETURN NEW;
  END IF;

  IF
    (OLD.status = 'open' AND NEW.status IN ('reviewing', 'resolved', 'dismissed'))
    OR (OLD.status = 'reviewing' AND NEW.status IN ('resolved', 'dismissed'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'report status transition is not allowed';
END;
$$;

CREATE TRIGGER reports_triage_lifecycle_trg
BEFORE UPDATE ON reports
FOR EACH ROW EXECUTE FUNCTION enforce_report_triage_lifecycle();

CREATE INDEX reports_status_created_at_id_idx
  ON reports (status, created_at DESC, id DESC);

DROP INDEX reports_question_revision_created_at_idx;

CREATE INDEX reports_question_revision_created_at_id_idx
  ON reports (question_revision_id, created_at DESC, id DESC)
  WHERE question_revision_id IS NOT NULL;
