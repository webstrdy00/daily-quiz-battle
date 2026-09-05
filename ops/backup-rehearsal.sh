#!/bin/sh

set -eu
set -f

container_name='daily-quiz-battle-postgres'
database_user='daily_quiz'
source_database='daily_quiz'
restore_database=''
restore_created=0
dump_file=''
cleanup_reported=0

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

is_safe_restore_database() {
  case "$1" in
    daily_quiz_restore_????????????????????????????????)
      restore_suffix=${1#daily_quiz_restore_}
      case "$restore_suffix" in
        *[!0-9a-f]*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

cleanup_resources() {
  cleanup_status=0

  if [ "$restore_created" -eq 1 ]; then
    if is_safe_restore_database "$restore_database"; then
      if docker exec "$container_name" \
        dropdb --if-exists --force -U "$database_user" "$restore_database" \
        >/dev/null 2>&1; then
        restore_created=0
        restore_database=''
      else
        cleanup_status=1
      fi
    else
      cleanup_status=1
    fi
  fi

  if [ -n "$dump_file" ]; then
    if rm -f -- "$dump_file" >/dev/null 2>&1; then
      dump_file=''
    else
      cleanup_status=1
    fi
  fi

  return "$cleanup_status"
}

on_exit() {
  exit_status=$?
  trap - 0 1 2 15

  if ! cleanup_resources; then
    if [ "$cleanup_reported" -eq 0 ]; then
      printf '%s\n' 'backup rehearsal: cleanup failed' >&2
    fi
    exit_status=1
  fi

  exit "$exit_status"
}

trap 'on_exit' 0
trap 'fail "backup rehearsal: interrupted"' 1 2 15

if ! command -v docker >/dev/null 2>&1; then
  fail 'backup rehearsal: docker is unavailable'
fi

if ! docker info >/dev/null 2>&1; then
  fail 'backup rehearsal: docker daemon is unavailable'
fi

if ! container_state=$(docker inspect \
  --format '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
  "$container_name" 2>/dev/null); then
  fail 'backup rehearsal: postgres container is unavailable'
fi

if [ "$container_state" != 'true|healthy' ]; then
  fail 'backup rehearsal: postgres container is not healthy'
fi

if ! docker exec "$container_name" sh -c \
  'command -v pg_dump >/dev/null 2>&1 &&
   command -v pg_restore >/dev/null 2>&1 &&
   command -v psql >/dev/null 2>&1 &&
   command -v createdb >/dev/null 2>&1 &&
   command -v dropdb >/dev/null 2>&1' \
  >/dev/null 2>&1; then
  fail 'backup rehearsal: required postgres command is unavailable'
fi

if ! start_seconds=$(date +%s 2>/dev/null); then
  fail 'backup rehearsal: clock command failed'
fi

if ! restore_hex=$(docker exec "$container_name" sh -c \
  "od -An -N16 -tx1 /dev/urandom | tr -d ' \\n'" 2>/dev/null); then
  fail 'backup rehearsal: random identifier generation failed'
fi

restore_candidate="daily_quiz_restore_$restore_hex"
if ! is_safe_restore_database "$restore_candidate"; then
  fail 'backup rehearsal: random identifier validation failed'
fi
restore_database=$restore_candidate

if ! dump_file=$(mktemp "${TMPDIR:-/tmp}/daily_quiz_backup.XXXXXX" 2>/dev/null); then
  fail 'backup rehearsal: temporary dump creation failed'
fi

metrics_sql="
WITH migration_metrics AS (
  SELECT
    count(*) AS migration_count,
    count(filename) AS filename_count,
    count(checksum) AS checksum_count,
    md5(
      coalesce(
        string_agg(filename || chr(31) || checksum, chr(30) ORDER BY filename, checksum),
        ''
      )
    ) AS migration_hash
  FROM public.app_migrations
),
table_metrics AS (
  SELECT
    (SELECT count(*) FROM public.users) AS users_count,
    (SELECT count(*) FROM public.daily_sets) AS daily_sets_count,
    (SELECT count(*) FROM public.question_revisions) AS question_revisions_count,
    (SELECT count(*) FROM public.challenges) AS challenges_count
),
target_tables(table_name) AS (
  VALUES
    ('users'::text),
    ('daily_sets'::text),
    ('question_revisions'::text),
    ('challenges'::text)
),
constraint_rows AS (
  SELECT
    relation.relname AS table_name,
    constraint_record.conname,
    constraint_record.contype,
    constraint_record.convalidated,
    constraint_record.conkey
  FROM pg_catalog.pg_constraint AS constraint_record
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = constraint_record.conrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  JOIN target_tables
    ON target_tables.table_name = relation.relname
  WHERE namespace.nspname = 'public'
),
constraint_metrics AS (
  SELECT
    (
      SELECT count(*)
      FROM target_tables
      WHERE NOT EXISTS (
        SELECT 1
        FROM constraint_rows
        WHERE constraint_rows.table_name = target_tables.table_name
      )
    ) AS tables_without_constraints,
    count(*) FILTER (WHERE NOT convalidated) AS unvalidated_constraints,
    count(*) AS constraint_count,
    md5(
      coalesce(
        string_agg(
          table_name || chr(31) || conname || chr(31) || contype::text ||
            chr(31) || coalesce(conkey::text, ''),
          chr(30)
          ORDER BY table_name, conname, contype, conkey
        ),
        ''
      )
    ) AS constraint_hash
  FROM constraint_rows
)
SELECT
  migration_count || '|' ||
  filename_count || '|' ||
  checksum_count || '|' ||
  migration_hash || '|' ||
  users_count || '|' ||
  daily_sets_count || '|' ||
  question_revisions_count || '|' ||
  challenges_count || '|' ||
  tables_without_constraints || '|' ||
  unvalidated_constraints || '|' ||
  constraint_count || '|' ||
  constraint_hash
FROM migration_metrics, table_metrics, constraint_metrics;
"

published_invariant_sql="
WITH invalid_published_sets AS (
  SELECT daily_sets.id
  FROM public.daily_sets
  LEFT JOIN public.daily_set_items
    ON daily_set_items.daily_set_id = daily_sets.id
  WHERE daily_sets.status = 'published'
  GROUP BY daily_sets.id
  HAVING count(daily_set_items.daily_set_id) <> 5
)
SELECT count(*) FROM invalid_published_sets;
"

query_read_only() {
  docker exec \
    -e 'PGOPTIONS=-c default_transaction_read_only=on' \
    "$container_name" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 \
    -U "$database_user" -d "$1" -c "$2" 2>/dev/null
}

if ! source_metrics_before=$(query_read_only "$source_database" "$metrics_sql"); then
  fail 'backup rehearsal: source verification query failed'
fi

if ! docker exec \
  -e 'PGOPTIONS=-c default_transaction_read_only=on' \
  "$container_name" \
  pg_dump --format=custom --no-owner --no-privileges --serializable-deferrable \
  -U "$database_user" -d "$source_database" \
  2>/dev/null >"$dump_file"; then
  fail 'backup rehearsal: pg_dump failed'
fi

if [ ! -s "$dump_file" ]; then
  fail 'backup rehearsal: pg_dump failed'
fi

if ! source_metrics_after=$(query_read_only "$source_database" "$metrics_sql"); then
  fail 'backup rehearsal: source verification query failed'
fi

if [ "$source_metrics_before" != "$source_metrics_after" ]; then
  fail 'backup rehearsal: source changed during backup'
fi

if ! docker exec "$container_name" \
  createdb -U "$database_user" --template=template0 "$restore_database" \
  >/dev/null 2>&1; then
  fail 'backup rehearsal: restore database creation failed'
fi
restore_created=1

if ! docker exec -i "$container_name" \
  pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
  -U "$database_user" --dbname="$restore_database" \
  2>/dev/null <"$dump_file"; then
  fail 'backup rehearsal: pg_restore failed'
fi

if ! restored_metrics=$(query_read_only "$restore_database" "$metrics_sql"); then
  fail 'backup rehearsal: restored verification query failed'
fi

if [ "$source_metrics_after" != "$restored_metrics" ]; then
  fail 'backup rehearsal: restored database verification failed'
fi

if ! invalid_published_sets=$(query_read_only \
  "$restore_database" "$published_invariant_sql"); then
  fail 'backup rehearsal: published daily set verification failed'
fi

if [ "$invalid_published_sets" != '0' ]; then
  fail 'backup rehearsal: published daily set invariant failed'
fi

saved_ifs=$IFS
IFS='|'
# shellcheck disable=SC2086 # Intentional IFS field splitting into positional values.
set -- $restored_metrics
IFS=$saved_ifs

if [ "$#" -ne 12 ]; then
  fail 'backup rehearsal: restored verification result is invalid'
fi

migration_count=$1
migration_filename_count=$2
migration_checksum_count=$3
users_count=$5
daily_sets_count=$6
question_revisions_count=$7
challenges_count=$8
tables_without_constraints=$9
shift 9
unvalidated_constraints=$1
constraint_count=$2

is_unsigned_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

for numeric_value in \
  "$migration_count" \
  "$migration_filename_count" \
  "$migration_checksum_count" \
  "$users_count" \
  "$daily_sets_count" \
  "$question_revisions_count" \
  "$challenges_count" \
  "$tables_without_constraints" \
  "$unvalidated_constraints" \
  "$constraint_count"; do
  if ! is_unsigned_integer "$numeric_value"; then
    fail 'backup rehearsal: restored verification result is invalid'
  fi
done

if [ "$migration_count" != "$migration_filename_count" ] ||
  [ "$migration_count" != "$migration_checksum_count" ]; then
  fail 'backup rehearsal: migration verification failed'
fi

if [ "$tables_without_constraints" != '0' ] ||
  [ "$unvalidated_constraints" != '0' ]; then
  fail 'backup rehearsal: constraint verification failed'
fi

if ! cleanup_resources; then
  cleanup_reported=1
  fail 'backup rehearsal: cleanup failed'
fi

if ! end_seconds=$(date +%s 2>/dev/null); then
  fail 'backup rehearsal: clock command failed'
fi

if ! is_unsigned_integer "$start_seconds" ||
  ! is_unsigned_integer "$end_seconds"; then
  fail 'backup rehearsal: clock result is invalid'
fi

duration_ms=$(((end_seconds - start_seconds) * 1000))
if [ "$duration_ms" -lt 0 ]; then
  fail 'backup rehearsal: clock result is invalid'
fi

printf \
  '{"local_rehearsal":true,"durationMs":%s,"migrationCount":%s,"tableCounts":{"users":%s,"daily_sets":%s,"question_revisions":%s,"challenges":%s}}\n' \
  "$duration_ms" \
  "$migration_count" \
  "$users_count" \
  "$daily_sets_count" \
  "$question_revisions_count" \
  "$challenges_count"
