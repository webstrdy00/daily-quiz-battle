CREATE TYPE challenge_status AS ENUM ('open', 'claimed', 'completed', 'expired');

CREATE TABLE challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token_hash varchar(64) NOT NULL,
  daily_set_id uuid NOT NULL REFERENCES daily_sets (id) ON DELETE RESTRICT,
  creator_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  creator_attempt_id uuid REFERENCES attempts (id) ON DELETE SET NULL,
  creator_score smallint,
  creator_nickname_snapshot varchar(20),
  claimed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  opponent_attempt_id uuid REFERENCES attempts (id) ON DELETE SET NULL,
  opponent_score smallint,
  opponent_nickname_snapshot varchar(20),
  status challenge_status NOT NULL DEFAULT 'open',
  source varchar(32) NOT NULL DEFAULT 'share_link',
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  result_redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenges_public_token_hash_uq UNIQUE (public_token_hash),
  CONSTRAINT challenges_creator_score_ck CHECK (creator_score IS NULL OR creator_score BETWEEN 0 AND 5),
  CONSTRAINT challenges_opponent_score_ck CHECK (opponent_score IS NULL OR opponent_score BETWEEN 0 AND 5),
  CONSTRAINT challenges_expires_after_created_ck CHECK (expires_at > created_at),
  CONSTRAINT challenges_distinct_participants_ck CHECK (
    creator_user_id IS NULL
    OR claimed_by_user_id IS NULL
    OR creator_user_id <> claimed_by_user_id
  ),
  CONSTRAINT challenges_source_ck CHECK (source IN ('share_link', 'share_message')),
  -- Per-status field requirements. A redacted row (account deletion) is exempt
  -- from the NOT NULL side so ON DELETE SET NULL can clear the deleted side.
  CONSTRAINT challenges_state_ck CHECK (
    result_redacted_at IS NOT NULL
    OR (
      status = 'open'
      AND creator_user_id IS NOT NULL
      AND creator_attempt_id IS NOT NULL
      AND creator_score IS NOT NULL
      AND creator_nickname_snapshot IS NOT NULL
      AND claimed_by_user_id IS NULL
      AND opponent_attempt_id IS NULL
      AND opponent_score IS NULL
      AND claimed_at IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'claimed'
      AND creator_user_id IS NOT NULL
      AND creator_attempt_id IS NOT NULL
      AND creator_score IS NOT NULL
      AND creator_nickname_snapshot IS NOT NULL
      AND claimed_by_user_id IS NOT NULL
      AND opponent_attempt_id IS NOT NULL
      AND opponent_nickname_snapshot IS NOT NULL
      AND claimed_at IS NOT NULL
      AND opponent_score IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'completed'
      AND creator_user_id IS NOT NULL
      AND creator_attempt_id IS NOT NULL
      AND creator_score IS NOT NULL
      AND creator_nickname_snapshot IS NOT NULL
      AND claimed_by_user_id IS NOT NULL
      AND opponent_attempt_id IS NOT NULL
      AND opponent_score IS NOT NULL
      AND opponent_nickname_snapshot IS NOT NULL
      AND claimed_at IS NOT NULL
      AND completed_at IS NOT NULL
    )
    OR (
      status = 'expired'
      AND claimed_by_user_id IS NULL
      AND opponent_attempt_id IS NULL
      AND completed_at IS NULL
    )
  )
);

CREATE INDEX challenges_creator_attempt_status_idx
  ON challenges (creator_attempt_id, status);
CREATE INDEX challenges_expires_status_idx
  ON challenges (expires_at, status);
CREATE INDEX challenges_opponent_attempt_idx
  ON challenges (opponent_attempt_id)
  WHERE opponent_attempt_id IS NOT NULL;

-- Legal transitions: open -> claimed | expired, claimed -> completed.
-- completed and expired are terminal. Redaction (Phase 4) only touches
-- score/nickname/result_redacted_at and is allowed in any status.
CREATE OR REPLACE FUNCTION enforce_challenge_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF
    (OLD.status = 'open' AND NEW.status IN ('claimed', 'expired'))
    OR (OLD.status = 'claimed' AND NEW.status = 'completed')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'challenge status transition % -> % is not allowed', OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER challenges_status_transition_trg
BEFORE UPDATE OF status ON challenges
FOR EACH ROW EXECUTE FUNCTION enforce_challenge_status_transition();

-- Identity columns never change after insert; the two attempt FKs may only be
-- cleared by ON DELETE SET NULL (account deletion), never re-pointed.
CREATE OR REPLACE FUNCTION enforce_challenge_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.public_token_hash IS DISTINCT FROM OLD.public_token_hash
    OR NEW.daily_set_id IS DISTINCT FROM OLD.daily_set_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.creator_attempt_id IS NOT NULL AND NEW.creator_attempt_id IS NOT NULL
        AND NEW.creator_attempt_id <> OLD.creator_attempt_id)
    OR (OLD.opponent_attempt_id IS NOT NULL AND NEW.opponent_attempt_id IS NOT NULL
        AND NEW.opponent_attempt_id <> OLD.opponent_attempt_id)
  THEN
    RAISE EXCEPTION 'challenge identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER challenges_immutable_columns_trg
BEFORE UPDATE ON challenges
FOR EACH ROW EXECUTE FUNCTION enforce_challenge_immutable_columns();
