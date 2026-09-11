ALTER TABLE users
  ADD COLUMN deleted_at timestamptz;

UPDATE users
SET deleted_at = updated_at
WHERE identity_status = 'deleted';

ALTER TABLE users
  ADD CONSTRAINT users_deleted_at_ck CHECK (
    (identity_status = 'deleted' AND deleted_at IS NOT NULL)
    OR (identity_status IN ('active', 'blocked') AND deleted_at IS NULL)
  );
