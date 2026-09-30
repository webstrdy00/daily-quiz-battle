import { createChallengeTokenService } from "../challenge/token.js";
import type { RuntimeConfig } from "../config.js";
import { createDatabase, type Database } from "../db/client.js";
import { runCleanup } from "../maintenance/cleanup.js";
import { runNotificationWorker } from "../notification/outbox.js";
import { createNotificationSender } from "../notification/sender.js";
import { createNotificationTargetCrypto } from "../notification/target-crypto.js";

const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_HOUR = 60 * 60 * MILLISECONDS_PER_SECOND;
const FAILURE_DELAY_LIMIT_MILLISECONDS = 5 * 60 * MILLISECONDS_PER_SECOND;
const OPERATIONS_LOCK_NAMESPACE = 0x445142;

type TaskName = "cleanup" | "notification_worker";
type LedgerPhase = "started" | "succeeded" | "failed";
type ReservedConnection = Awaited<ReturnType<Database["client"]["reserve"]>>;

interface ScheduledTask {
  name: TaskName;
  lockKey: number;
  intervalMilliseconds: number;
  run(database: Database): Promise<object>;
}

type TaskResult =
  | {
      status: "completed" | "failed";
      ledgerFailures: LedgerPhase[];
      infrastructureFailed: boolean;
    }
  | { status: "scheduler_failed" | "skipped_locked" | "stopping" };

interface LockRow {
  acquired: boolean;
}

interface ShutdownController {
  isStopping(): boolean;
  requestStop(): void;
  wait(milliseconds: number): Promise<void>;
}

function writeLog(
  stream: NodeJS.WriteStream,
  entry: Record<string, unknown>,
): void {
  stream.write(`${JSON.stringify(entry)}\n`);
}

function createShutdownController(): ShutdownController {
  let stopping = false;
  const wakeWaiters = new Set<() => void>();

  return {
    isStopping: () => stopping,
    requestStop() {
      if (stopping) {
        return;
      }

      stopping = true;
      for (const wake of wakeWaiters) {
        wake();
      }
    },
    async wait(milliseconds) {
      if (stopping) {
        return;
      }

      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          wakeWaiters.delete(finish);
          resolve();
        };
        const timeout = setTimeout(finish, milliseconds);
        wakeWaiters.add(finish);
      });
    },
  };
}

function failureDelayMilliseconds(
  failureCount: number,
  intervalMilliseconds: number,
): number {
  const exponent = Math.min(failureCount - 1, 9);
  return Math.min(
    intervalMilliseconds,
    FAILURE_DELAY_LIMIT_MILLISECONDS,
    MILLISECONDS_PER_SECOND * 2 ** exponent,
  );
}

async function recordTaskStarted(
  connection: ReservedConnection,
  taskName: TaskName,
  startedAt: Date,
): Promise<void> {
  await connection`
    INSERT INTO operation_task_runs (
      task_name,
      last_started_at,
      updated_at
    )
    VALUES (
      ${taskName},
      ${startedAt.toISOString()},
      current_timestamp
    )
    ON CONFLICT (task_name) DO UPDATE
    SET last_started_at = EXCLUDED.last_started_at,
        updated_at = EXCLUDED.updated_at
  `;
}

async function recordTaskSucceeded(
  connection: ReservedConnection,
  taskName: TaskName,
  startedAt: Date,
  durationMs: number,
): Promise<void> {
  await connection`
    INSERT INTO operation_task_runs (
      task_name,
      last_started_at,
      last_succeeded_at,
      consecutive_failures,
      last_duration_ms,
      updated_at
    )
    VALUES (
      ${taskName},
      ${startedAt.toISOString()},
      current_timestamp,
      0,
      ${durationMs},
      current_timestamp
    )
    ON CONFLICT (task_name) DO UPDATE
    SET last_started_at = EXCLUDED.last_started_at,
        last_succeeded_at = EXCLUDED.last_succeeded_at,
        consecutive_failures = 0,
        last_duration_ms = EXCLUDED.last_duration_ms,
        updated_at = EXCLUDED.updated_at
  `;
}

async function recordTaskFailed(
  connection: ReservedConnection,
  taskName: TaskName,
  startedAt: Date,
  durationMs: number,
): Promise<void> {
  await connection`
    INSERT INTO operation_task_runs (
      task_name,
      last_started_at,
      last_failed_at,
      consecutive_failures,
      last_duration_ms,
      updated_at
    )
    VALUES (
      ${taskName},
      ${startedAt.toISOString()},
      current_timestamp,
      1,
      ${durationMs},
      current_timestamp
    )
    ON CONFLICT (task_name) DO UPDATE
    SET last_started_at = EXCLUDED.last_started_at,
        last_failed_at = EXCLUDED.last_failed_at,
        consecutive_failures =
          operation_task_runs.consecutive_failures + 1,
        last_duration_ms = EXCLUDED.last_duration_ms,
        updated_at = EXCLUDED.updated_at
  `;
}

function markInfrastructureFailure(result: TaskResult): TaskResult {
  if (result.status === "completed" || result.status === "failed") {
    return { ...result, infrastructureFailed: true };
  }

  return { status: "scheduler_failed" };
}

async function executeTask(
  task: ScheduledTask,
  database: Database,
  shutdown: ShutdownController,
): Promise<TaskResult> {
  let result: TaskResult = { status: "scheduler_failed" };
  let acquired = false;

  let connection: ReservedConnection;
  try {
    connection = await database.client.reserve();
  } catch {
    return result;
  }

  try {
    const rows = await connection<LockRow[]>`
      SELECT pg_try_advisory_lock(
        ${OPERATIONS_LOCK_NAMESPACE},
        ${task.lockKey}
      ) AS acquired
    `;
    acquired = rows[0]?.acquired === true;

    if (!acquired) {
      result = { status: "skipped_locked" };
    } else if (shutdown.isStopping()) {
      result = { status: "stopping" };
    } else {
      const startedAt = new Date();
      const ledgerFailures: LedgerPhase[] = [];

      try {
        await recordTaskStarted(connection, task.name, startedAt);
      } catch {
        ledgerFailures.push("started");
      }
      const taskStartedAtMilliseconds = Date.now();

      try {
        await task.run(database);
        const durationMs = Math.max(0, Date.now() - taskStartedAtMilliseconds);

        try {
          await recordTaskSucceeded(
            connection,
            task.name,
            startedAt,
            durationMs,
          );
        } catch {
          ledgerFailures.push("succeeded");
        }

        result = {
          status: "completed",
          ledgerFailures,
          infrastructureFailed: false,
        };
      } catch {
        const durationMs = Math.max(0, Date.now() - taskStartedAtMilliseconds);

        try {
          await recordTaskFailed(connection, task.name, startedAt, durationMs);
        } catch {
          ledgerFailures.push("failed");
        }

        result = {
          status: "failed",
          ledgerFailures,
          infrastructureFailed: false,
        };
      }
    }
  } catch {
    result = { status: "scheduler_failed" };
  } finally {
    if (acquired) {
      try {
        await connection`
          SELECT pg_advisory_unlock(
            ${OPERATIONS_LOCK_NAMESPACE},
            ${task.lockKey}
          )
        `;
      } catch {
        result = markInfrastructureFailure(result);
      }
    }

    try {
      connection.release();
    } catch {
      result = markInfrastructureFailure(result);
    }
  }

  return result;
}

function logTaskResult(task: ScheduledTask, result: TaskResult): void {
  if (result.status === "stopping") {
    return;
  }

  if (result.status === "completed" || result.status === "failed") {
    for (const phase of result.ledgerFailures) {
      writeLog(process.stderr, {
        task: task.name,
        status: "ledger_write_failed",
        phase,
      });
    }

    if (result.infrastructureFailed) {
      writeLog(process.stderr, {
        task: task.name,
        status: "scheduler_failed",
      });
    }
  }

  writeLog(
    result.status === "completed" || result.status === "skipped_locked"
      ? process.stdout
      : process.stderr,
    { task: task.name, status: result.status },
  );
}

async function runTasksOnce(
  tasks: ScheduledTask[],
  database: Database,
  shutdown: ShutdownController,
): Promise<boolean> {
  let succeeded = true;
  for (const task of tasks) {
    if (shutdown.isStopping()) {
      return false;
    }

    const result = await executeTask(task, database, shutdown);
    logTaskResult(task, result);
    if (
      result.status !== "skipped_locked" &&
      (result.status !== "completed" ||
        result.infrastructureFailed ||
        result.ledgerFailures.length > 0)
    ) {
      succeeded = false;
    }
  }
  return succeeded;
}

async function runTaskLoop(
  task: ScheduledTask,
  database: Database,
  shutdown: ShutdownController,
): Promise<void> {
  let consecutiveFailures = 0;

  while (!shutdown.isStopping()) {
    const result = await executeTask(task, database, shutdown);
    if (result.status === "stopping") {
      return;
    }

    logTaskResult(task, result);

    if (result.status === "completed") {
      if (
        !result.infrastructureFailed &&
        !result.ledgerFailures.includes("succeeded")
      ) {
        consecutiveFailures = 0;
        await shutdown.wait(task.intervalMilliseconds);
        continue;
      }
    }

    if (result.status === "skipped_locked") {
      consecutiveFailures = 0;
      await shutdown.wait(task.intervalMilliseconds);
      continue;
    }

    consecutiveFailures += 1;
    await shutdown.wait(
      failureDelayMilliseconds(consecutiveFailures, task.intervalMilliseconds),
    );
  }
}

function createNotificationTask(
  config: RuntimeConfig,
): ScheduledTask | undefined {
  if (
    !config.resultNotificationTemplateSetCode ||
    !config.identityMtlsCert ||
    !config.identityMtlsKey
  ) {
    return undefined;
  }

  const targetCrypto = createNotificationTargetCrypto({
    key: config.notificationTargetEncryptionKey,
    version: config.notificationTargetEncryptionKeyVersion,
    previous:
      config.notificationTargetEncryptionKeyPrevious !== undefined &&
      config.notificationTargetEncryptionKeyVersionPrevious !== undefined
        ? {
            key: config.notificationTargetEncryptionKeyPrevious,
            version: config.notificationTargetEncryptionKeyVersionPrevious,
          }
        : undefined,
  });
  const challengeTokens = createChallengeTokenService({
    secret: config.challengeTokenSecret,
    previousSecret: config.challengeTokenSecretPrevious,
  });
  const sender = createNotificationSender(
    config,
    targetCrypto,
    challengeTokens,
  );

  return {
    name: "notification_worker",
    lockKey: 1,
    intervalMilliseconds:
      config.operationsNotificationIntervalSeconds * MILLISECONDS_PER_SECOND,
    run: (database) => runNotificationWorker(database, sender),
  };
}

export async function runOperations(
  config: RuntimeConfig,
  mode: "once" | "schedule",
): Promise<boolean> {
  const once = mode === "once";
  if (
    config.appEnvironment !== "development" &&
    !config.operationsSchedulerEnabled
  ) {
    throw new Error("Operations scheduler is not explicitly enabled");
  }

  const shutdown = createShutdownController();
  const handleSignal = () => shutdown.requestStop();
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  let database: Database | undefined;
  let succeeded = true;
  try {
    database = createDatabase(config);
    const tasks: ScheduledTask[] = [
      {
        name: "cleanup",
        lockKey: 2,
        intervalMilliseconds:
          config.operationsCleanupIntervalHours * MILLISECONDS_PER_HOUR,
        run: (taskDatabase) =>
          runCleanup(taskDatabase, new Date(), {
            operationalRetentionEnabled: config.operationalRetentionEnabled,
          }),
      },
    ];

    if (config.notificationDeliveryEnabled === false) {
      writeLog(process.stdout, {
        task: "notification_worker",
        status: "disabled_by_flag",
      });
    } else {
      const notificationTask = createNotificationTask(config);
      if (notificationTask === undefined) {
        writeLog(process.stdout, {
          task: "notification_worker",
          status: "disabled_unconfigured",
        });
      } else {
        tasks.push(notificationTask);
      }
    }

    if (once) {
      succeeded = await runTasksOnce(tasks, database, shutdown);
    } else {
      const taskDatabase = database;
      await Promise.all(
        tasks.map((task) => runTaskLoop(task, taskDatabase, shutdown)),
      );
    }
  } finally {
    try {
      await database?.close();
    } finally {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
      if (once && shutdown.isStopping()) {
        succeeded = false;
      }
    }
  }
  return succeeded;
}
