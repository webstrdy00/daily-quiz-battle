CREATE TABLE operation_task_runs (
  task_name text PRIMARY KEY,
  last_started_at timestamptz NOT NULL,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_duration_ms integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT operation_task_runs_task_name_ck CHECK (
    task_name IN ('cleanup', 'notification_worker')
  ),
  CONSTRAINT operation_task_runs_consecutive_failures_ck CHECK (
    consecutive_failures >= 0
  ),
  CONSTRAINT operation_task_runs_last_duration_ms_ck CHECK (
    last_duration_ms >= 0
  )
);
