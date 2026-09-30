-- Run as migration owner after app migrations, using a session endpoint.
-- These are NOLOGIN privilege groups. Provision separate login credentials and
-- grant exactly one group to each login; never use the migration owner at runtime.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.operation_task_runs') IS NULL OR
     to_regclass('public.notification_outbox') IS NULL THEN
    RAISE EXCEPTION 'Apply app migrations before provisioning runtime privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daily_quiz_api') THEN
    CREATE ROLE daily_quiz_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daily_quiz_worker') THEN
    CREATE ROLE daily_quiz_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('daily_quiz_api', 'daily_quiz_worker')
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Existing runtime groups have unexpected elevated attributes';
  END IF;
END
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM daily_quiz_api, daily_quiz_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM daily_quiz_api, daily_quiz_worker;
GRANT USAGE ON SCHEMA public TO daily_quiz_api, daily_quiz_worker;
REVOKE CREATE ON SCHEMA public FROM daily_quiz_api, daily_quiz_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO daily_quiz_api;
REVOKE ALL ON public.app_migrations FROM daily_quiz_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO daily_quiz_worker;
REVOKE ALL ON public.app_migrations FROM daily_quiz_worker;
GRANT UPDATE, DELETE ON public.challenges, public.idempotency_records TO daily_quiz_worker;
GRANT UPDATE ON public.notification_outbox, public.users TO daily_quiz_worker;
GRANT DELETE ON public.reports, public.notification_outbox, public.admin_audit_logs TO daily_quiz_worker;
-- SELECT FOR UPDATE SKIP LOCKED requires UPDATE on at least one column.
-- Grant only the primary key, not report triage or audit payload mutation.
GRANT UPDATE (id) ON public.reports, public.admin_audit_logs TO daily_quiz_worker;
GRANT INSERT, UPDATE ON public.operation_task_runs TO daily_quiz_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO daily_quiz_api, daily_quiz_worker;
-- No table ownership, DDL, role management, TRUNCATE or future-object defaults.
-- Rerun after migrations which introduce tables requiring runtime privileges.
COMMIT;
