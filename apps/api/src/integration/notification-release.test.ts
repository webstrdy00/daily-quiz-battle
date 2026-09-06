import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));
const workerPath = fileURLToPath(
  new URL("../notification/run-worker.ts", import.meta.url),
);
const configUrl = new URL("../config.ts", import.meta.url).href;
const childTimeout = 10_000;
const testTimeout = 30_000;

function runChild(
  args: string[],
  overrides: Record<string, string | undefined> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "notification-release-"));
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
    APP_ENV: "production",
    DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unreachable",
    IDENTITY_VERIFICATION_MODE: "mtls",
    IDENTITY_MTLS_CERT: join(directory, "missing-cert.pem"),
    IDENTITY_MTLS_KEY: join(directory, "missing-key.pem"),
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
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[name];
    }
  }

  try {
    // Resolve tsx from the API package, then isolate loadConfig's .env search.
    // Both cwd and ../../.env are inside this test's empty temporary directory.
    const isolate = `data:text/javascript,${encodeURIComponent(
      `process.chdir(${JSON.stringify(isolatedDirectory)});`,
    )}`;
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", isolate, ...args],
      {
        cwd: apiDirectory,
        env,
        encoding: "utf8",
        timeout: childTimeout,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function configProbe(expectedError?: string): string[] {
  return [
    "--input-type=module",
    "--eval",
    `
      const { loadConfig } = await import(${JSON.stringify(configUrl)});
      try {
        const config = loadConfig();
        process.stdout.write(JSON.stringify({
          notificationDeliveryEnabled: config.notificationDeliveryEnabled,
        }) + "\\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({
          expectedError: error instanceof Error &&
            error.message === ${JSON.stringify(expectedError) ?? "undefined"},
        }) + "\\n");
        process.exitCode = 1;
      }
    `,
  ];
}

function assertChild(
  child: ReturnType<typeof runChild>,
  status: number,
  output: unknown,
): void {
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, status);
  assert.equal(child.stderr, "");
  assert.equal(child.stdout, `${JSON.stringify(output)}\n`);
}

test(
  "notification delivery defaults off in every environment",
  { timeout: testTimeout },
  () => {
    for (const appEnvironment of ["development", "staging", "production"]) {
      assertChild(runChild(configProbe(), { APP_ENV: appEnvironment }), 0, {
        notificationDeliveryEnabled: false,
      });
    }
  },
);

test(
  "disabled standalone worker exits before database, crypto, or sender setup",
  { timeout: testTimeout },
  () => {
    assertChild(
      runChild([workerPath], { NOTIFICATION_DELIVERY_ENABLED: "false" }),
      0,
      { task: "notification_worker", status: "disabled_by_flag" },
    );
  },
);

test(
  "enabled non-development delivery requires a template before setup",
  { timeout: testTimeout },
  () => {
    for (const appEnvironment of ["staging", "production"]) {
      assertChild(
        runChild(
          configProbe(
            "Non-development RESULT_NOTIFICATION_TEMPLATE_SET_CODE is required",
          ),
          {
            APP_ENV: appEnvironment,
            NOTIFICATION_DELIVERY_ENABLED: "true",
          },
        ),
        1,
        { expectedError: true },
      );
    }
  },
);

test(
  "enabled standalone worker preserves sanitized configuration failure",
  { timeout: testTimeout },
  () => {
    const child = runChild([workerPath], {
      NOTIFICATION_DELIVERY_ENABLED: "true",
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, '{"error":"notification_worker_failed"}\n');
  },
);

test(
  "enabled delivery accepts a configured template without opening connections",
  { timeout: testTimeout },
  () => {
    assertChild(
      runChild(configProbe(), {
        NOTIFICATION_DELIVERY_ENABLED: "true",
        RESULT_NOTIFICATION_TEMPLATE_SET_CODE: "fixture-result-template",
      }),
      0,
      { notificationDeliveryEnabled: true },
    );
  },
);

test(
  "disabled delivery does not bypass identity mTLS validation",
  { timeout: testTimeout },
  () => {
    assertChild(
      runChild(
        configProbe("mTLS identity verification requires certificate and key"),
        {
          NOTIFICATION_DELIVERY_ENABLED: "false",
          IDENTITY_MTLS_CERT: undefined,
        },
      ),
      1,
      { expectedError: true },
    );
  },
);
