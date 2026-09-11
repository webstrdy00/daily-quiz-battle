CREATE OR REPLACE FUNCTION enforce_daily_set_item_mutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_status daily_set_status;
  new_status daily_set_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO old_status FROM daily_sets WHERE id = OLD.daily_set_id;
    IF old_status <> 'draft' THEN
      RAISE EXCEPTION 'published daily set items are immutable';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO new_status FROM daily_sets WHERE id = NEW.daily_set_id;
    IF new_status <> 'draft' THEN
      RAISE EXCEPTION 'published daily set items are immutable';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER attempt_answers_no_update_trg ON attempt_answers;

CREATE TRIGGER attempt_answers_immutable_trg
BEFORE UPDATE OR DELETE ON attempt_answers
FOR EACH ROW EXECUTE FUNCTION prevent_answer_update();
