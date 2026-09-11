import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createDatabase, type Database } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { seedDatabase } from "../db/seed.js";

const DEFAULT_TEST_DATABASE_ADMIN_URL =
  "postgres://daily_quiz:daily_quiz_local@127.0.0.1:5432/postgres";
const TEST_DATABASE_NAME_PATTERN = /^daily_quiz_it_[0-9a-f]{32}$/;
const silentLog = (): void => undefined;

export const PRIMARY_QUIZ_DATE = "2026-08-29";
export const NEXT_QUIZ_DATE = "2026-08-30";
export const PRIMARY_DAY_NOON = new Date("2026-08-29T03:00:00.000Z");
export const NEXT_DAY_NOON = new Date("2026-08-30T03:00:00.000Z");

export interface IntegrationHarness {
  app: FastifyInstance;
  readonly config: Readonly<AppConfig>;
  database: Database;
  databaseName: string;
  databaseUrl: string;
  setNow(value: Date | string): void;
  close(): Promise<void>;
}

function createTestDatabaseName(): string {
  return `daily_quiz_it_${randomUUID().replaceAll("-", "")}`;
}

function assertSafeTestDatabaseName(databaseName: string): void {
  if (!TEST_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Refusing unsafe test database name: ${databaseName}`);
  }
}

function resolveAdminUrl(): string {
  const value =
    process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_TEST_DATABASE_ADMIN_URL;
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_ADMIN_URL must use postgres protocol");
  }
  return url.toString();
}

function createDatabaseUrl(adminUrl: string, databaseName: string): string {
  assertSafeTestDatabaseName(databaseName);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createTemporaryDatabase(
  adminUrl: string,
  databaseName: string,
): Promise<void> {
  assertSafeTestDatabaseName(databaseName);
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropTemporaryDatabase(
  adminUrl: string,
  databaseName: string,
): Promise<void> {
  assertSafeTestDatabaseName(databaseName);
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  try {
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function createTestConfig(databaseUrl: string): AppConfig {
  return {
    appEnvironment: "development",
    apiHost: "127.0.0.1",
    apiPort: 3000,
    logLevel: "silent",
    databaseUrl,
    databasePoolMax: 5,
    identityVerificationMode: "mock",
    identityVerifyUrl: "https://example.invalid/test-identity",
    anonymousKeyPepper:
      "integration-test-anonymous-key-pepper-do-not-use-in-production",
    accessTokenSecret:
      "integration-test-access-token-secret-do-not-use-in-production",
    accessTokenTtlSeconds: 1800,
    accessTokenIssuer: "daily-quiz-battle-integration-test",
    accessTokenAudience: "daily-quiz-battle-integration-client",
    adminAccessTokenSecret:
      "integration-test-admin-access-token-secret-do-not-use-in-production",
    adminAccessTokenIssuer: "daily-quiz-battle-admin-integration-test",
    adminAccessTokenAudience: "daily-quiz-battle-content-api-integration-test",
    challengeTokenSecret:
      "integration-test-challenge-token-secret-do-not-use-in-production",
    notificationTargetEncryptionKey: Buffer.alloc(32, 7),
    notificationTargetEncryptionKeyVersion: 1,
    resultNotificationTemplateSetCode: "integration-result-template",
    notificationDeliveryEnabled: true,
    notificationSendUrl:
      "https://example.invalid/apps-in-toss/messenger/send-message",
    // Concurrency tests fire bursts far above the per-user limits.
    rateLimitEnabled: false,
    allowedOrigins: ["http://localhost:5173"],
  };
}

export async function createIntegrationHarness(): Promise<IntegrationHarness> {
  const adminUrl = resolveAdminUrl();
  const databaseName = createTestDatabaseName();
  const databaseUrl = createDatabaseUrl(adminUrl, databaseName);
  let database: Database | undefined;
  let app: FastifyInstance | undefined;
  let databaseCreated = false;
  let currentNow = new Date(PRIMARY_DAY_NOON);

  try {
    await createTemporaryDatabase(adminUrl, databaseName);
    databaseCreated = true;

    await runMigrations(databaseUrl, { log: silentLog });
    await runMigrations(databaseUrl, { log: silentLog });
    await seedDatabase(databaseUrl, { now: PRIMARY_DAY_NOON, log: silentLog });
    await seedDatabase(databaseUrl, { now: PRIMARY_DAY_NOON, log: silentLog });
    await seedDatabase(databaseUrl, { now: NEXT_DAY_NOON, log: silentLog });
    await seedDatabase(databaseUrl, { now: NEXT_DAY_NOON, log: silentLog });

    const config = createTestConfig(databaseUrl);
    database = createDatabase(config);
    app = await buildApp({
      config,
      database,
      clock: () => new Date(currentNow),
    });

    let closed = false;
    return {
      app,
      config,
      database,
      databaseName,
      databaseUrl,
      setNow(value) {
        currentNow = new Date(value);
        if (Number.isNaN(currentNow.getTime())) {
          throw new Error(`Invalid integration test clock value: ${value}`);
        }
      },
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await app?.close();
        } finally {
          await dropTemporaryDatabase(adminUrl, databaseName);
        }
      },
    };
  } catch (error) {
    try {
      if (app !== undefined) {
        await app.close();
      } else if (database !== undefined) {
        await database.close();
      }
    } finally {
      if (databaseCreated) {
        await dropTemporaryDatabase(adminUrl, databaseName);
      }
    }
    throw error;
  }
}
