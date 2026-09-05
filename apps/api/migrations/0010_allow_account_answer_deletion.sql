CREATE OR REPLACE FUNCTION prevent_answer_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deletion_user_id uuid;
  answer_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    deletion_user_id := NULLIF(
      current_setting('app.account_deletion_user_id', true),
      ''
    )::uuid;

    IF deletion_user_id IS NOT NULL THEN
      SELECT user_id
      INTO answer_user_id
      FROM attempts
      WHERE id = OLD.attempt_id;

      IF answer_user_id = deletion_user_id THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;

  RAISE EXCEPTION 'submitted answers are immutable';
END;
$$;
