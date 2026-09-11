import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));
const schedulerPath = fileURLToPath(
  new URL("../operations/scheduler.ts", import.meta.url),
);
const childTimeout = 20_000;
const testTimeout = 60_000;
const disabledLog = {
  task: "notification_worker",
  status: "disabled_by_flag",
};

function runChild(
  databaseUrl: string,
  overrides: Record<string, string> = {},
  args = ["--once"],
  entrypoint = [schedulerPath],
) {
  const directory = mkdtempSync(join(tmpdir(), "operations-once-"));
  const isolatedDirectory = join(directory, "isolated", "runtime");
  mkdirSync(isolatedDirectory, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
  ]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  Object.assign(env, {
    APP_ENV: "development",
    DATABASE_URL: databaseUrl,
    ANON_KEY_PEPPER: "fixture-anonymous-key-pepper-not-a-secret-2026",
    ACCESS_TOKEN_SECRET: "fixture-access-token-secret-not-a-secret-2026",
    ADMIN_ACCESS_TOKEN_SECRET: "fixture-admin-token-secret-not-a-secret-2026",
    CHALLENGE_TOKEN_SECRET: "fixture-challenge-secret-not-a-secret-2026",
    NOTIFICATION_TARGET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    RATE_LIMIT_REDIS_URL: "redis://127.0.0.1:1",
    METRICS_ACCESS_TOKEN: "fixture-metrics-access-token-not-a-secret-2026",
    ALLOWED_ORIGINS: "https://web.example.test",
    ...overrides,
  });

  try {
    // Resolve tsx from the API package while keeping both .env candidates isolated.
    const isolate = `data:text/javascript,${encodeURIComponent(
      `process.chdir(${JSON.stringify(isolatedDirectory)});`,
    )}`;
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", isolate, ...entrypoint, ...args],
      {
        cwd: apiDirectory,
        env,
        encoding: "utf8",
        timeout: childTimeout,
        killSignal: "SIGKILL",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertChild(
  child: ReturnType<typeof runChild>,
  status: number,
  stdout: object[],
  stderr: object[] = [],
): void {
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, status);
  const encode = (entries: object[]) =>
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  assert.equal(child.stdout, encode(stdout));
  assert.equal(child.stderr, encode(stderr));
}

async function createFixture(t: TestContext) {
  const harness = await createIntegrationHarness();
  t.after(() => harness.close());
  const userId = randomUUID();
  const recordId = randomUUID();
  await harness.database.client`
    INSERT INTO users (id, anon_key_fingerprint, nickname, identity_verified_at)
    VALUES (${userId}, ${randomUUID().replaceAll("-", "").repeat(2)}, 'once', current_timestamp)
  `;
  await harness.database.client`
    INSERT INTO idempotency_records (
      id, user_id, operation, key_hash, request_hash, expires_at
    )
    VALUES (
      ${recordId}, ${userId}, 'operations-once', ${"a".repeat(64)},
      ${"b".repeat(64)}, '2000-01-01T00:00:00Z'
    )
  `;
  return { harness, recordId };
}

async function recordExists(harness: IntegrationHarness, recordId: string) {
  const rows = await harness.database.client`
    SELECT id FROM idempotency_records WHERE id = ${recordId}
  `;
  return rows.length === 1;
}

async function readLedger(harness: IntegrationHarness) {
  return harness.database.client`
    SELECT task_name,
      last_started_at IS NOT NULL AS started,
      last_succeeded_at IS NOT NULL AS succeeded,
      last_failed_at IS NOT NULL AS failed,
      consecutive_failures,
      last_duration_ms >= 0 AS valid_duration
    FROM operation_task_runs ORDER BY task_name
  `;
}

test(
  "once completes cleanup, records success, and leaves notification disabled",
  {
    timeout: testTimeout,
  },
  async (t) => {
    const { harness, recordId } = await createFixture(t);
    assertChild(runChild(harness.databaseUrl), 0, [
      disabledLog,
      { task: "cleanup", status: "completed" },
    ]);
    assert.equal(await recordExists(harness, recordId), false);
    assert.deepEqual(
      [...(await readLedger(harness))],
      [
        {
          task_name: "cleanup",
          started: true,
          succeeded: true,
          failed: false,
          consecutive_failures: 0,
          valid_duration: true,
        },
      ],
    );
  },
);

test(
  "once skips a session-owned cleanup lock without touching cleanup or ledger",
  {
    timeout: testTimeout,
  },
  async (t) => {
    const { harness, recordId } = await createFixture(t);
    const connection = await harness.database.client.reserve();
    try {
      await connection`SELECT pg_advisory_lock(${0x445142}, ${2})`;
      assertChild(runChild(harness.databaseUrl), 0, [
        disabledLog,
        { task: "cleanup", status: "skipped_locked" },
      ]);
      assert.equal(await recordExists(harness, recordId), true);
      assert.equal((await readLedger(harness)).length, 0);
    } finally {
      await connection`SELECT pg_advisory_unlock(${0x445142}, ${2})`;
      connection.release();
    }
    // The same task can run after the owning session relinquishes its lock.
    assertChild(runChild(harness.databaseUrl), 0, [
      disabledLog,
      { task: "cleanup", status: "completed" },
    ]);
    assert.equal(await recordExists(harness, recordId), false);
  },
);

for (const phase of ["started", "succeeded"] as const) {
  test(
    `once fails on a ${phase} ledger write even when cleanup succeeds`,
    {
      timeout: testTimeout,
    },
    async (t) => {
      const { harness, recordId } = await createFixture(t);
      // BEFORE INSERT sees each attempted upsert before conflict resolution.
      await harness.database.client.unsafe(`
      CREATE FUNCTION reject_once_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.last_succeeded_at IS ${phase === "started" ? "NULL" : "NOT NULL"} THEN
          RAISE EXCEPTION 'private-ledger-error-do-not-log';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_once_ledger BEFORE INSERT ON operation_task_runs
      FOR EACH ROW EXECUTE FUNCTION reject_once_ledger();
    `);
      assertChild(
        runChild(harness.databaseUrl),
        1,
        [disabledLog, { task: "cleanup", status: "completed" }],
        [{ task: "cleanup", status: "ledger_write_failed", phase }],
      );
      assert.equal(await recordExists(harness, recordId), false);
      const ledger = await readLedger(harness);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.succeeded, phase === "started");
    },
  );
}

for (const rejectFailureLedger of [false, true]) {
  test(
    `once sanitizes cleanup failure with failed ledger rejection ${rejectFailureLedger}`,
    {
      timeout: testTimeout,
    },
    async (t) => {
      const { harness, recordId } = await createFixture(t);
      await harness.database.client.unsafe(`
      CREATE FUNCTION reject_once_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'private-job-error-do-not-log';
      END;
      $$;
      CREATE TRIGGER reject_once_cleanup BEFORE DELETE ON idempotency_records
      FOR EACH ROW EXECUTE FUNCTION reject_once_cleanup();
    `);
      if (rejectFailureLedger) {
        await harness.database.client.unsafe(`
        ALTER TABLE operation_task_runs ADD CONSTRAINT reject_failed_ledger
        CHECK (last_failed_at IS NULL);
      `);
      }
      assertChild(
        runChild(harness.databaseUrl),
        1,
        [disabledLog],
        [
          ...(rejectFailureLedger
            ? [
                {
                  task: "cleanup",
                  status: "ledger_write_failed",
                  phase: "failed",
                },
              ]
            : []),
          { task: "cleanup", status: "failed" },
        ],
      );
      assert.equal(await recordExists(harness, recordId), true);
      const ledger = await readLedger(harness);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.succeeded, false);
      assert.equal(ledger[0]!.failed, !rejectFailureLedger);
      assert.equal(
        ledger[0]!.consecutive_failures,
        rejectFailureLedger ? 0 : 1,
      );
    },
  );
}

test(
  "once preserves unconfigured notification handling",
  {
    timeout: testTimeout,
  },
  async (t) => {
    const { harness } = await createFixture(t);
    assertChild(
      runChild(harness.databaseUrl, {
        NOTIFICATION_DELIVERY_ENABLED: "true",
      }),
      0,
      [
        { task: "notification_worker", status: "disabled_unconfigured" },
        { task: "cleanup", status: "completed" },
      ],
    );
  },
);

test(
  "once preserves nondevelopment scheduler authorization",
  {
    timeout: testTimeout,
  },
  async (t) => {
    const { harness, recordId } = await createFixture(t);
    const production = {
      APP_ENV: "production",
      IDENTITY_VERIFICATION_MODE: "mtls",
      IDENTITY_MTLS_CERT: "unused-disabled-notification-cert.pem",
      IDENTITY_MTLS_KEY: "unused-disabled-notification-key.pem",
    };
    assertChild(
      runChild(harness.databaseUrl, production),
      1,
      [],
      [{ component: "operations_scheduler", status: "failed" }],
    );
    assert.equal(await recordExists(harness, recordId), true);
    assert.equal((await readLedger(harness)).length, 0);
    assertChild(
      runChild(harness.databaseUrl, {
        ...production,
        OPERATIONS_SCHEDULER_ENABLED: "true",
      }),
      0,
      [disabledLog, { task: "cleanup", status: "completed" }],
    );
    assert.equal(await recordExists(harness, recordId), false);
  },
);

test(
  "once reports unavailable database infrastructure without leaking connection details",
  {
    timeout: testTimeout,
  },
  async (t) => {
    const { harness, recordId } = await createFixture(t);
    const unavailable = new URL(harness.databaseUrl);
    unavailable.pathname = `/${harness.databaseName}_missing`;
    assertChild(
      runChild(unavailable.toString()),
      1,
      [disabledLog],
      [{ task: "cleanup", status: "scheduler_failed" }],
    );
    assert.equal(await recordExists(harness, recordId), true);
    assert.equal((await readLedger(harness)).length, 0);
  },
);

test(
  "unknown or duplicate CLI arguments fail without exposing raw arguments",
  {
    timeout: testTimeout,
  },
  () => {
    for (const args of [
      ["--once", "private-argument-do-not-log"],
      ["--once", "--once"],
    ]) {
      assertChild(
        runChild(
          "postgres://fixture:fixture@127.0.0.1:1/unreachable",
          {},
          args,
        ),
        1,
        [],
        [{ component: "operations_scheduler", status: "failed" }],
      );
    }
  },
);

test("runner and scheduled function imports have no runtime side effects", () => {
  const modules = [
    new URL("../operations/runner.ts", import.meta.url).href,
    new URL("../netlify/operations.ts", import.meta.url).href,
  ];
  const source = `
    import assert from "node:assert/strict";
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const exitCode = process.exitCode;
    for (const path of ${JSON.stringify(modules)}) await import(path);
    assert.deepEqual(
      [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before,
    );
    assert.equal(process.exitCode, exitCode);
  `;
  assertChild(
    runChild(
      "postgres://fixture:fixture@127.0.0.1:1/unreachable",
      { APP_ENV: "invalid" },
      [],
      ["--input-type=module", "--eval", source],
    ),
    0,
    [],
  );
});

test("scheduled operations fail closed with sanitized errors", () => {
  const functionUrl = new URL("../netlify/operations.ts", import.meta.url).href;
  const source = `
    import assert from "node:assert/strict";
    const { default: operations, config } = await import(${JSON.stringify(functionUrl)});
    assert.equal(config.schedule, "@daily");
    const exitCode = process.exitCode;
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await assert.rejects(
      operations(new Request("https://example.test/"), {}),
      (error) => {
        assert.equal(error.message, "operations_failed");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(process.exitCode, exitCode);
    assert.deepEqual(
      [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before,
    );
  `;
  const production = {
    APP_ENV: "production",
    IDENTITY_VERIFICATION_MODE: "mtls",
    IDENTITY_MTLS_CERT: "unused-disabled-notification-cert.pem",
    IDENTITY_MTLS_KEY: "unused-disabled-notification-key.pem",
    OPERATIONS_SCHEDULER_ENABLED: "true",
  };
  const endpoint =
    "postgres://fixture:private-password@127.0.0.1:1/unreachable";
  const cases: Record<string, string>[] = [
    { APP_ENV: "development", OPERATIONS_SCHEDULER_ENABLED: "true" },
    { ...production, OPERATIONS_SCHEDULER_ENABLED: "false" },
    production,
    { ...production, OPERATIONS_DATABASE_URL: "private-invalid-url" },
    {
      ...production,
      OPERATIONS_DATABASE_URL: "https://example.test/db?sslmode=verify-full",
    },
    { ...production, OPERATIONS_DATABASE_URL: endpoint },
    { ...production, OPERATIONS_DATABASE_URL: `${endpoint}?sslmode=require` },
    {
      ...production,
      OPERATIONS_DATABASE_URL: `${endpoint}?sslmode=verify-full&sslmode=disable`,
    },
  ];
  for (const overrides of cases) {
    assertChild(
      runChild(
        endpoint,
        overrides,
        [],
        ["--input-type=module", "--eval", source],
      ),
      0,
      [],
    );
  }
  // A valid explicit endpoint reaches the runner; infrastructure failure still
  // rejects without exposing credentials or mutating the process exit status.
  assertChild(
    runChild(
      endpoint,
      {
        ...production,
        OPERATIONS_DATABASE_URL: `${endpoint}?sslmode=verify-full`,
      },
      [],
      ["--input-type=module", "--eval", source],
    ),
    0,
    [disabledLog],
    [{ task: "cleanup", status: "scheduler_failed" }],
  );
});
