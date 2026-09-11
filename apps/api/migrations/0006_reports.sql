CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question_revision_id uuid REFERENCES question_revisions (id) ON DELETE RESTRICT,
  challenge_id uuid REFERENCES challenges (id) ON DELETE RESTRICT,
  reason_code varchar(32) NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dedupe_window_start timestamptz GENERATED ALWAYS AS (
    date_bin(
      interval '10 minutes',
      created_at,
      timestamptz '1970-01-01 00:00:00+00'
    )
  ) STORED,
  CONSTRAINT reports_target_xor_ck CHECK (
    num_nonnulls(question_revision_id, challenge_id) = 1
  ),
  CONSTRAINT reports_reason_code_ck CHECK (
    reason_code IN (
      'incorrect_answer',
      'ambiguous',
      'outdated',
      'inappropriate',
      'other'
    )
  ),
  CONSTRAINT reports_detail_length_ck CHECK (
    detail IS NULL OR char_length(detail) BETWEEN 1 AND 500
  )
);

CREATE UNIQUE INDEX reports_question_dedupe_uq
  ON reports (
    reporter_user_id,
    question_revision_id,
    reason_code,
    dedupe_window_start
  )
  WHERE question_revision_id IS NOT NULL;

CREATE INDEX reports_question_revision_created_at_idx
  ON reports (question_revision_id, created_at DESC)
  WHERE question_revision_id IS NOT NULL;
