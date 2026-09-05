ALTER TABLE attempts
  ADD COLUMN challenge_id uuid REFERENCES challenges (id) ON DELETE SET NULL;

CREATE INDEX attempts_challenge_id_idx ON attempts (challenge_id);

CREATE OR REPLACE FUNCTION enforce_attempt_challenge_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
    AND NEW.challenge_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'attempt challenge provenance is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER attempts_challenge_provenance_immutable_trg
BEFORE UPDATE OF challenge_id ON attempts
FOR EACH ROW EXECUTE FUNCTION enforce_attempt_challenge_provenance();
