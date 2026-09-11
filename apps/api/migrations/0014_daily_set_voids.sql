CREATE TABLE daily_set_voids (
  daily_set_id uuid PRIMARY KEY
    REFERENCES daily_sets(id) ON DELETE RESTRICT,
  actor_subject varchar(100) NOT NULL,
  reason varchar(500) NOT NULL,
  voided_at timestamptz NOT NULL,
  CONSTRAINT daily_set_voids_actor_subject_ck CHECK (
    char_length(btrim(actor_subject)) BETWEEN 1 AND 100
    AND actor_subject = btrim(actor_subject)
  ),
  CONSTRAINT daily_set_voids_reason_ck CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 500
    AND reason = btrim(reason)
  )
);

CREATE OR REPLACE FUNCTION enforce_daily_set_void_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  set_published_at timestamptz;
BEGIN
  SELECT published_at INTO set_published_at
  FROM daily_sets
  WHERE id = NEW.daily_set_id
  FOR UPDATE;

  IF set_published_at IS NULL THEN
    RAISE EXCEPTION 'only published daily sets can be voided';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER daily_set_voids_insert_guard_trg
BEFORE INSERT ON daily_set_voids
FOR EACH ROW EXECUTE FUNCTION enforce_daily_set_void_insert();

CREATE OR REPLACE FUNCTION enforce_daily_set_void_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'daily set void records are immutable';
END;
$$;

CREATE TRIGGER daily_set_voids_immutable_trg
BEFORE UPDATE OR DELETE ON daily_set_voids
FOR EACH ROW EXECUTE FUNCTION enforce_daily_set_void_immutability();

CREATE INDEX challenges_daily_set_id_idx
ON challenges(daily_set_id);

CREATE INDEX notification_outbox_pending_challenge_id_idx
ON notification_outbox(challenge_id)
WHERE status = 'pending';
