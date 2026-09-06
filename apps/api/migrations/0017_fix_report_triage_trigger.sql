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
