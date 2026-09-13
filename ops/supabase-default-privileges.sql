-- Run as postgres through the session pooler before the first app migration.
-- No tables or existing functions are changed. Refuse nonempty public schemas.
BEGIN;
DO $$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Expected postgres migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public') THEN
    RAISE EXCEPTION 'Public tables exist; review object-specific grants before hardening';
  END IF;
END
$$;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, PUBLIC;
-- PUBLIC execute is global by default and cannot be removed at schema scope.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
