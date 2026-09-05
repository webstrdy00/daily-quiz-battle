CREATE TYPE notification_event_type AS ENUM ('challenge.completed');
CREATE TYPE notification_outbox_status AS ENUM ('pending', 'published', 'failed');

CREATE TABLE notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  result_enabled boolean NOT NULL DEFAULT false,
  encrypted_anon_key bytea,
  iv bytea,
  auth_tag bytea,
  key_version integer,
  agreed_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_key_version_ck CHECK (
    key_version IS NULL OR key_version > 0
  ),
  CONSTRAINT notification_preferences_state_ck CHECK (
    (
      result_enabled
      AND encrypted_anon_key IS NOT NULL
      AND iv IS NOT NULL
      AND auth_tag IS NOT NULL
      AND key_version IS NOT NULL
      AND agreed_at IS NOT NULL
      AND revoked_at IS NULL
    )
    OR (
      NOT result_enabled
      AND encrypted_anon_key IS NULL
      AND iv IS NULL
      AND auth_tag IS NULL
    )
  )
);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type notification_event_type NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE RESTRICT,
  dedupe_key text NOT NULL,
  status notification_outbox_status NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error varchar(500),
  occurred_at timestamptz NOT NULL,
  published_at timestamptz,
  CONSTRAINT notification_outbox_dedupe_key_uq UNIQUE (dedupe_key),
  CONSTRAINT notification_outbox_attempt_count_ck CHECK (attempt_count >= 0)
);

CREATE INDEX notification_outbox_pending_available_at_idx
  ON notification_outbox (available_at, occurred_at)
  WHERE status = 'pending';
