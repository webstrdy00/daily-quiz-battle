-- Run with the migration owner on a direct/session endpoint using verify-full.
-- This audit never applies migrations or changes privileges.
BEGIN READ ONLY;

-- Behind a pooler this describes pooler-to-Postgres, not client-to-pooler TLS.
SELECT current_database() AS database, current_user AS role,
       (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS backend_ssl;

SELECT tablename, tableowner, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Supabase defaults can grant browser roles access to newly migrated tables.
-- Review before migration; disabling Data API alone does not remove grants.
SELECT d.defaclrole::regrole::text AS owner,
       d.defaclobjtype AS object_type,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE a.grantee::regrole::text END AS grantee,
       a.privilege_type
FROM pg_default_acl d
CROSS JOIN LATERAL aclexplode(d.defaclacl) a
WHERE d.defaclnamespace = 'public'::regnamespace
ORDER BY owner, object_type, grantee, privilege_type;

SELECT grantee, table_name, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;

SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls
FROM pg_roles r
WHERE r.rolname = current_user;

SELECT extname, extversion FROM pg_extension ORDER BY extname;
COMMIT;
