ALTER TABLE reports
  DROP CONSTRAINT reports_challenge_id_fkey;

CREATE INDEX reports_challenge_created_at_idx
  ON reports (challenge_id, created_at DESC)
  WHERE challenge_id IS NOT NULL;
