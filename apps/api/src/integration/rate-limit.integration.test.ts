import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { ApiErrorSchema } from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createDatabase, type Database } from "../db/client.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

const RATE_LIMIT_NAMESPACE = "daily-quiz-battle:rate-limit:";
const IP_BUCKET_HASH_DOMAIN = "daily-quiz-battle:rate-limit:ip:v1\0";
const TEST_REDIS_DATABASE_INDEX = 15;
const configuredRedisUrl = process.env.TEST_REDIS_URL?.trim();

interface AppResource {
  app?: FastifyInstance;
  database: Database;
}

function requireIsolatedRedisUrl(): string {
  if (configuredRedisUrl === undefined || configuredRedisUrl.length === 0) {
    throw new Error("TEST_REDIS_URL is required");
  }

  const url = new URL(configuredRedisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("TEST_REDIS_URL must use the redis or rediss protocol");
  }

  const databaseMatch = /^\/(\d+)$/.exec(url.pathname);
  const databaseIndex =
    databaseMatch === null ? Number.NaN : Number(databaseMatch[1]);
  if (databaseIndex !== TEST_REDIS_DATABASE_INDEX) {
    throw new Error(
      `TEST_REDIS_URL must use isolated Redis database index ${TEST_REDIS_DATABASE_INDEX}; database 0 is forbidden`,
    );
  }

  return configuredRedisUrl;
}

function createIpNamespace(): {
  primaryIp: string;
  secondaryIp: string;
} {
  const id = randomUUID().replaceAll("-", "");
  const networkPrefix = [
    `fd${id.slice(0, 2)}`,
    id.slice(2, 6),
    id.slice(6, 10),
    id.slice(10, 14),
    id.slice(14, 18),
    id.slice(18, 22),
    id.slice(22, 26),
  ].join(":");

  return {
    primaryIp: `${networkPrefix}:1`,
    secondaryIp: `${networkPrefix}:2`,
  };
}

function expectedIpBucket(ip: string): string {
  const digest = createHash("sha256")
    .update(IP_BUCKET_HASH_DOMAIN, "utf8")
    .update(ip, "utf8")
    .digest("hex");
  return `ip-sha256:${digest}`;
}

function keyPatternForIp(ip: string): string {
  return `${RATE_LIMIT_NAMESPACE}*${expectedIpBucket(ip)}`;
}

function createForgedJwt(subject: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, tokenVersion: 0 }),
  ).toString("base64url");
  const invalidSignature = Buffer.alloc(32, 0xa5).toString("base64url");
  return `${header}.${payload}.${invalidSignature}`;
}

function assertPrivateBucketKey(
  key: string,
  ip: string,
  rawIdentifiers: readonly string[],
): void {
  const bucket = expectedIpBucket(ip);
  assert.match(bucket, /^ip-sha256:[0-9a-f]{64}$/);
  assert.equal(bucket.length, 74);
  assert.equal(key.endsWith(bucket), true, key);
  assert.ok(key.length <= 256, `rate-limit key is unexpectedly long: ${key}`);
  assert.equal(key.includes(ip), false, key);
  for (const identifier of rawIdentifiers) {
    assert.equal(key.includes(identifier), false, key);
  }
}

async function findTestNamespaceKeys(
  redis: Redis,
  keyPattern: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, page] = await redis.scan(
      cursor,
      "MATCH",
      keyPattern,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...page);
  } while (cursor !== "0");

  return keys;
}

async function deleteTestNamespaceKeys(
  redis: Redis,
  keyPatterns: readonly string[],
): Promise<void> {
  const keys = [
    ...new Set(
      (
        await Promise.all(
          keyPatterns.map((keyPattern) =>
            findTestNamespaceKeys(redis, keyPattern),
          ),
        )
      ).flat(),
    ),
  ];
  if (keys.length === 0) {
    return;
  }

  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.unlink(key);
  }
  const results = await pipeline.exec();
  if (results === null) {
    throw new Error("Redis namespace cleanup did not return results");
  }
  for (const [error] of results) {
    if (error !== null) {
      throw error;
    }
  }
}

async function findOnlyNewKey(
  redis: Redis,
  keyPattern: string,
  previousKeys: ReadonlySet<string>,
): Promise<string> {
  const keys = await findTestNamespaceKeys(redis, keyPattern);
  const newKeys = keys.filter((key) => !previousKeys.has(key));
  assert.equal(
    newKeys.length,
    1,
    `expected one new rate-limit key, found ${JSON.stringify(newKeys)}`,
  );
  return newKeys[0]!;
}

async function assertCounterWithTtl(
  redis: Redis,
  key: string,
  expectedCount: number,
): Promise<void> {
  assert.equal(await redis.get(key), String(expectedCount));
  const ttl = await redis.pttl(key);
  assert.ok(
    ttl > 0 && ttl <= 600_000,
    `unexpected Redis TTL ${ttl} for ${key}`,
  );
}

async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === "end") {
    return;
  }

  try {
    await redis.quit();
  } catch {
    redis.disconnect(false);
  }
}

async function closeAppResources(resources: AppResource[]): Promise<void> {
  const results = await Promise.allSettled(
    resources
      .reverse()
      .map(({ app, database }) => app?.close() ?? database.close()),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to close rate-limit test apps");
  }
}

test(
  "Redis rate limits share private pre-auth IP buckets across instances",
  {
    skip:
      configuredRedisUrl === undefined || configuredRedisUrl.length === 0
        ? "TEST_REDIS_URL is not set; shared Redis integration test skipped"
        : false,
  },
  async () => {
    const redisUrl = requireIsolatedRedisUrl();
    const { primaryIp, secondaryIp } = createIpNamespace();
    const primaryKeyPattern = keyPatternForIp(primaryIp);
    const secondaryKeyPattern = keyPatternForIp(secondaryIp);
    const cleanupPatterns = [primaryKeyPattern, secondaryKeyPattern];
    const redis = new Redis(redisUrl, {
      connectionName: "daily-quiz-battle-rate-limit-integration-cleanup",
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    const resources: AppResource[] = [];
    let harness: IntegrationHarness | undefined;
    let redisConnected = false;

    try {
      await redis.connect();
      redisConnected = true;
      assert.equal(await redis.ping(), "PONG");
      await deleteTestNamespaceKeys(redis, cleanupPatterns);

      harness = await createIntegrationHarness();
      const config: AppConfig = {
        ...harness.config,
        appEnvironment: "production",
        metricsAccessToken:
          "shared-rate-limit-integration-test-metrics-access-token",
        rateLimitEnabled: true,
        rateLimitRedisUrl: redisUrl,
      };
      const apps: FastifyInstance[] = [];

      for (let instance = 0; instance < 2; instance += 1) {
        const resource: AppResource = {
          database: createDatabase(config),
        };
        resources.push(resource);
        resource.app = await buildApp({
          config,
          database: resource.database,
        });
        apps.push(resource.app);
      }

      const rotatingSubjects = [
        `${randomUUID()}:${"x".repeat(2_048)}`,
        ...Array.from({ length: 31 }, () => randomUUID()),
      ];
      const rawIdentifiers = rotatingSubjects;
      const anonymousKey = `dev-shared-rate-limit-${randomUUID().replaceAll("-", "")}`;

      for (let requestIndex = 0; requestIndex < 30; requestIndex += 1) {
        const authorization =
          requestIndex === 28
            ? "Bearer malformed"
            : requestIndex === 29
              ? `Bearer ${createForgedJwt(rotatingSubjects[0]!)}`
              : undefined;
        const response = await apps[requestIndex % apps.length]!.inject({
          method: "POST",
          url: "/v1/auth/bootstrap",
          remoteAddress: primaryIp,
          headers: authorization === undefined ? undefined : { authorization },
          payload: { anonymousKey },
        });
        assert.equal(response.statusCode, 200, response.body);
      }
      const bootstrapKey = await findOnlyNewKey(
        redis,
        primaryKeyPattern,
        new Set(),
      );
      assertPrivateBucketKey(bootstrapKey, primaryIp, rawIdentifiers);
      await assertCounterWithTtl(redis, bootstrapKey, 30);

      const limited = await apps[0]!.inject({
        method: "POST",
        url: "/v1/auth/bootstrap",
        remoteAddress: primaryIp,
        payload: { anonymousKey },
      });
      assert.equal(limited.statusCode, 429, limited.body);
      const error = ApiErrorSchema.parse(limited.json());
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.retryable, true);
      assert.equal(error.requestId, limited.headers["x-request-id"]);
      const retryAfterMs = error.details?.retryAfterMs;
      assert.ok(
        typeof retryAfterMs === "number" &&
          Number.isInteger(retryAfterMs) &&
          retryAfterMs > 0 &&
          retryAfterMs <= 600_000,
      );
      await assertCounterWithTtl(redis, bootstrapKey, 31);

      const independent = await apps[1]!.inject({
        method: "POST",
        url: "/v1/auth/bootstrap",
        remoteAddress: secondaryIp,
        headers: {
          authorization: `Bearer ${createForgedJwt(rotatingSubjects[1]!)}`,
        },
        payload: { anonymousKey },
      });
      assert.equal(independent.statusCode, 200, independent.body);
      const secondaryKey = await findOnlyNewKey(
        redis,
        secondaryKeyPattern,
        new Set(),
      );
      assertPrivateBucketKey(secondaryKey, secondaryIp, rawIdentifiers);
      await assertCounterWithTtl(redis, secondaryKey, 1);

      const primaryKeys = new Set(
        await findTestNamespaceKeys(redis, primaryKeyPattern),
      );
      for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
        const authorization =
          requestIndex === 0
            ? "Bearer malformed"
            : `Bearer ${createForgedJwt(rotatingSubjects[requestIndex - 1]!)}`;
        const response = await apps[requestIndex % apps.length]!.inject({
          method: "POST",
          url: "/v1/challenges",
          remoteAddress: primaryIp,
          headers: { authorization },
        });
        assert.equal(response.statusCode, 401, response.body);
      }
      const principalRouteKey = await findOnlyNewKey(
        redis,
        primaryKeyPattern,
        primaryKeys,
      );
      primaryKeys.add(principalRouteKey);
      assertPrivateBucketKey(principalRouteKey, primaryIp, rawIdentifiers);
      await assertCounterWithTtl(redis, principalRouteKey, 10);

      const principalLimited = await apps[1]!.inject({
        method: "POST",
        url: "/v1/challenges",
        remoteAddress: primaryIp,
        headers: {
          authorization: `Bearer ${createForgedJwt(rotatingSubjects[9]!)}`,
        },
      });
      assert.equal(principalLimited.statusCode, 429, principalLimited.body);
      const principalError = ApiErrorSchema.parse(principalLimited.json());
      assert.equal(principalError.code, "RATE_LIMITED");
      assert.equal(principalError.retryable, true);
      assert.equal(
        principalError.requestId,
        principalLimited.headers["x-request-id"],
      );
      await assertCounterWithTtl(redis, principalRouteKey, 11);

      for (let requestIndex = 0; requestIndex < 20; requestIndex += 1) {
        const authorization =
          requestIndex === 0
            ? "Bearer malformed"
            : `Bearer ${createForgedJwt(rotatingSubjects[requestIndex + 9]!)}`;
        const response = await apps[requestIndex % apps.length]!.inject({
          method: "POST",
          url: "/v1/challenges/forged-token/claim",
          remoteAddress: primaryIp,
          headers: { authorization },
        });
        assert.equal(response.statusCode, 401, response.body);
      }
      const combinedRouteKey = await findOnlyNewKey(
        redis,
        primaryKeyPattern,
        primaryKeys,
      );
      assertPrivateBucketKey(combinedRouteKey, primaryIp, rawIdentifiers);
      await assertCounterWithTtl(redis, combinedRouteKey, 20);

      const combinedLimited = await apps[0]!.inject({
        method: "POST",
        url: "/v1/challenges/forged-token/claim",
        remoteAddress: primaryIp,
        headers: {
          authorization: `Bearer ${createForgedJwt(rotatingSubjects[29]!)}`,
        },
      });
      assert.equal(combinedLimited.statusCode, 429, combinedLimited.body);
      const combinedError = ApiErrorSchema.parse(combinedLimited.json());
      assert.equal(combinedError.code, "RATE_LIMITED");
      assert.equal(combinedError.retryable, true);
      assert.equal(
        combinedError.requestId,
        combinedLimited.headers["x-request-id"],
      );
      await assertCounterWithTtl(redis, combinedRouteKey, 21);

      const primaryRedisKeys = await findTestNamespaceKeys(
        redis,
        primaryKeyPattern,
      );
      assert.deepEqual(
        primaryRedisKeys.sort(),
        [bootstrapKey, principalRouteKey, combinedRouteKey].sort(),
      );
      const allRateLimitKeys = await findTestNamespaceKeys(
        redis,
        `${RATE_LIMIT_NAMESPACE}*`,
      );
      for (const identifier of [primaryIp, secondaryIp, ...rawIdentifiers]) {
        assert.equal(
          allRateLimitKeys.some((key) => key.includes(identifier)),
          false,
          `raw identifier was stored in a rate-limit key: ${identifier}`,
        );
      }
    } finally {
      try {
        await closeAppResources(resources);
      } finally {
        try {
          await harness?.close();
        } finally {
          if (redisConnected) {
            try {
              await deleteTestNamespaceKeys(redis, cleanupPatterns);
            } finally {
              await closeRedis(redis);
            }
          } else {
            redis.disconnect(false);
          }
        }
      }
    }
  },
);
