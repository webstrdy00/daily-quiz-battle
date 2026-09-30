-- Run once as a provisioning administrator connected to database postgres.
-- Public-only schema + data backup; excludes Supabase auth/storage, roles and grants.
-- No login/password is created. Provision a dedicated login separately and grant it
-- this group. Existing API/worker roles and default privileges remain unchanged.
-- Deliberately create-only: existing groups are rejected, not silently trusted or
-- altered. Review/drop an unused existing group separately before reprovisioning.
-- No membership/nesting is created here. Reapply explicit object grants after new
-- migrations add tables or sequences; this script does not change default grants.
BEGIN;

DO $backup_role$
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Backup role provisioning requires database postgres';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'daily_quiz_backup') THEN
    RAISE EXCEPTION 'Existing daily_quiz_backup role is not trusted; review it separately';
  END IF;
  CREATE ROLE daily_quiz_backup
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
    NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;
END
$backup_role$;

GRANT CONNECT ON DATABASE postgres TO daily_quiz_backup;
GRANT USAGE ON SCHEMA public TO daily_quiz_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO daily_quiz_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO daily_quiz_backup;

COMMIT;
