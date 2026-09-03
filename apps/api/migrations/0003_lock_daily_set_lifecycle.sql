CREATE OR REPLACE FUNCTION enforce_daily_set_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'published daily sets cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF
    (OLD.status = 'draft' AND NEW.status IN ('published', 'retired'))
    OR (OLD.status = 'published' AND NEW.status = 'retired')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'daily set status transition is not allowed';
END;
$$;

CREATE TRIGGER daily_sets_status_transition_trg
BEFORE UPDATE OF status ON daily_sets
FOR EACH ROW EXECUTE FUNCTION enforce_daily_set_status_transition();

CREATE TRIGGER daily_sets_delete_guard_trg
BEFORE DELETE ON daily_sets
FOR EACH ROW EXECUTE FUNCTION enforce_daily_set_status_transition();

CREATE OR REPLACE FUNCTION enforce_daily_set_item_mutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_status daily_set_status;
  new_status daily_set_status;
  locked_set record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO new_status
    FROM daily_sets
    WHERE id = NEW.daily_set_id
    FOR UPDATE;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT status INTO old_status
    FROM daily_sets
    WHERE id = OLD.daily_set_id
    FOR UPDATE;
  ELSIF OLD.daily_set_id = NEW.daily_set_id THEN
    SELECT status INTO old_status
    FROM daily_sets
    WHERE id = OLD.daily_set_id
    FOR UPDATE;
    new_status := old_status;
  ELSE
    FOR locked_set IN
      SELECT id, status
      FROM daily_sets
      WHERE id IN (OLD.daily_set_id, NEW.daily_set_id)
      ORDER BY id
      FOR UPDATE
    LOOP
      IF locked_set.id = OLD.daily_set_id THEN
        old_status := locked_set.status;
      END IF;
      IF locked_set.id = NEW.daily_set_id THEN
        new_status := locked_set.status;
      END IF;
    END LOOP;
  END IF;

  IF TG_OP <> 'INSERT' AND old_status <> 'draft' THEN
    RAISE EXCEPTION 'published daily set items are immutable';
  END IF;

  IF TG_OP <> 'DELETE' AND new_status <> 'draft' THEN
    RAISE EXCEPTION 'published daily set items are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
