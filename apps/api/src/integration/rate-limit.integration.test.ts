import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  DeleteAccountResponseSchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Redis } from "ioredis";
import { buildApp } from "../app.js";
import { createAccessTokenService } from "../auth/token.js";
import type { AppConfig } from "../config.js";
import { createDatabase, type Database } from "../db/client.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

const RATE_LIMIT_NAMESPACE = "daily-quiz-battle:rate-limit:";
const IP_BUCKET_HASH_DOMAIN = "daily-quiz-battle:rate-limit:ip:v1\0";
const ACCOUNT_BUCKET_HASH_DOMAIN =
  "daily-quiz-battle:rate-limit:account-delete:v1\0";
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

function expectedAccountBucket(userId: string): string {
  const digest = createHash("sha256")
    .update(ACCOUNT_BUCKET_HASH_DOMAIN, "utf8")
    .update(userId, "utf8")
    .digest("hex");
  return `account-delete-sha256:${digest}`;
}

function keyPatternForAccount(userId: string): string {
  return `${RATE_LIMIT_NAMESPACE}*${expectedAccountBucket(userId)}`;
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

for (const mode of ["memory", "sharedRedis"] as const) {
  test(
    `account deletion separates verified-user quotas from pre-auth IP limits (${mode})`,
    {
      skip:
        mode === "sharedRedis" &&
        (configuredRedisUrl === undefined || configuredRedisUrl.length === 0)
          ? "TEST_REDIS_URL is not set; shared Redis integration test skipped"
          : false,
    },
    async () => {
      const redisUrl =
        mode === "sharedRedis" ? requireIsolatedRedisUrl() : undefined;
      const redis =
        redisUrl === undefined
          ? undefined
          : new Redis(redisUrl, {
              connectionName:
                "daily-quiz-battle-account-rate-limit-integration-cleanup",
              enableOfflineQueue: false,
              lazyConnect: true,
              maxRetriesPerRequest: 1,
            });
      const { primaryIp, secondaryIp } = createIpNamespace();
      const { primaryIp: forgedIp } = createIpNamespace();
      const ips = [primaryIp, secondaryIp, forgedIp];
      const cleanupPatterns = ips.map(keyPatternForIp);
      const resources: AppResource[] = [];
      let harness: IntegrationHarness | undefined;
      let redisConnected = false;

      try {
        if (redis !== undefined) {
          await redis.connect();
          redisConnected = true;
          assert.equal(await redis.ping(), "PONG");
          await deleteTestNamespaceKeys(redis, cleanupPatterns);
        }

        harness = await createIntegrationHarness();
        const config: AppConfig = {
          ...harness.config,
          appEnvironment: mode === "sharedRedis" ? "production" : "development",
          metricsAccessToken:
            "account-rate-limit-integration-test-metrics-access-token",
          rateLimitEnabled: true,
          rateLimitRedisUrl: redisUrl,
        };
        const apps: FastifyInstance[] = [];
        const instanceCount = mode === "sharedRedis" ? 2 : 1;
        for (let instance = 0; instance < instanceCount; instance += 1) {
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

        const users: { userId: string; token: string }[] = [];
        for (let userIndex = 0; userIndex < 3; userIndex += 1) {
          const response: LightMyRequestResponse = await harness.app.inject({
            method: "POST",
            url: "/v1/auth/bootstrap",
            payload: {
              anonymousKey: `dev-account-rate-limit-${randomUUID().replaceAll("-", "")}`,
            },
          });
          assert.equal(response.statusCode, 200, response.body);
          const bootstrap = BootstrapResponseSchema.parse(response.json());
          users.push({
            userId: bootstrap.user.id,
            token: bootstrap.accessToken,
          });
          cleanupPatterns.push(keyPatternForAccount(bootstrap.user.id));
        }
        const freshUser = users[0]!;
        const activeUsers = users.slice(1);
        const forgedSubjects = [
          ...activeUsers.map((user) => user.userId),
          `${randomUUID()}:${"x".repeat(2_048)}`,
          ...Array.from({ length: 58 }, () => randomUUID()),
        ];
        const forgedTokens = forgedSubjects.map(createForgedJwt);
        cleanupPatterns.push(...forgedSubjects.map(keyPatternForAccount));

        const requestDeletion = (
          app: FastifyInstance,
          ip: string,
          token?: string,
          confirmation = "delete",
        ) =>
          app.inject({
            method: "DELETE",
            url: "/v1/me",
            remoteAddress: ip,
            headers:
              token === undefined
                ? undefined
                : { authorization: `Bearer ${token}` },
            payload: { confirmation },
          });

        const expectLimitedDeletion = async (
          app: FastifyInstance,
          ip: string,
          token: string,
          minimumRetrySeconds: number,
          maximumRetrySeconds: number,
        ): Promise<void> => {
          const response = await requestDeletion(app, ip, token);
          assert.equal(response.statusCode, 429, response.body);
          const error = ApiErrorSchema.parse(response.json());
          assert.equal(error.code, "RATE_LIMITED");
          assert.equal(error.retryable, true);
          assert.equal(error.requestId, response.headers["x-request-id"]);
          const retryAfter = Number(response.headers["retry-after"]);
          assert.ok(
            Number.isInteger(retryAfter) &&
              retryAfter >= minimumRetrySeconds &&
              retryAfter <= maximumRetrySeconds,
            `unexpected Retry-After ${response.headers["retry-after"]}`,
          );
          const retryAfterMs = error.details?.retryAfterMs;
          assert.ok(
            typeof retryAfterMs === "number" &&
              retryAfterMs > 0 &&
              retryAfterMs <= maximumRetrySeconds * 1_000,
          );
        };

        for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
          const response = await requestDeletion(
            apps[requestIndex % apps.length]!,
            primaryIp,
            undefined,
            "DELETE",
          );
          assert.equal(response.statusCode, 401, response.body);
        }
        if (redis !== undefined) {
          for (const user of users) {
            assert.deepEqual(
              await findTestNamespaceKeys(
                redis,
                keyPatternForAccount(user.userId),
              ),
              [],
            );
          }
        }

        const deleted = await requestDeletion(
          apps[apps.length - 1]!,
          primaryIp,
          freshUser.token,
          "DELETE",
        );
        assert.equal(deleted.statusCode, 200, deleted.body);
        assert.equal(
          DeleteAccountResponseSchema.parse(deleted.json()).status,
          "deleted",
        );
        const deletedRows = await harness.database.client<
          { identity_status: string }[]
        >`
          SELECT identity_status FROM users WHERE id = ${freshUser.userId}
        `;
        assert.equal(deletedRows[0]?.identity_status, "deleted");

        for (let requestIndex = 0; requestIndex < 60; requestIndex += 1) {
          const response = await requestDeletion(
            apps[requestIndex % apps.length]!,
            forgedIp,
            forgedTokens[requestIndex]!,
            "DELETE",
          );
          assert.equal(response.statusCode, 401, response.body);
        }
        await expectLimitedDeletion(
          apps[apps.length - 1]!,
          forgedIp,
          forgedTokens[60]!,
          1,
          60,
        );
        const unknownUserToken = await createAccessTokenService(config).issue({
          userId: forgedSubjects[3]!,
          tokenVersion: 0,
        });
        const unknownUser = await requestDeletion(
          apps[0]!,
          primaryIp,
          unknownUserToken,
          "DELETE",
        );
        assert.equal(unknownUser.statusCode, 401, unknownUser.body);
        if (redis !== undefined) {
          for (const subject of forgedSubjects) {
            assert.deepEqual(
              await findTestNamespaceKeys(redis, keyPatternForAccount(subject)),
              [],
              `unverified subject created an account bucket: ${subject}`,
            );
          }
        }

        for (const user of activeUsers) {
          for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
            const response = await requestDeletion(
              apps[requestIndex % apps.length]!,
              primaryIp,
              user.token,
            );
            assert.equal(response.statusCode, 400, response.body);
            assert.equal(
              ApiErrorSchema.parse(response.json()).code,
              "INVALID_REQUEST",
            );
          }
          await expectLimitedDeletion(
            apps[apps.length - 1]!,
            primaryIp,
            user.token,
            86_340,
            86_400,
          );
        }
        await expectLimitedDeletion(
          apps[0]!,
          secondaryIp,
          activeUsers[0]!.token,
          86_340,
          86_400,
        );
        for (const user of activeUsers) {
          const rows: { identity_status: string }[] = await harness.database
            .client<{ identity_status: string }[]>`
            SELECT identity_status FROM users WHERE id = ${user.userId}
          `;
          assert.equal(rows[0]?.identity_status, "active");
        }

        if (redis !== undefined) {
          const rawIdentifiers = [
            ...ips,
            ...users.flatMap((user) => [user.userId, user.token]),
            ...forgedSubjects,
            ...forgedTokens,
            unknownUserToken,
          ];
          for (const [ip, count] of [
            [primaryIp, 13],
            [secondaryIp, 1],
            [forgedIp, 61],
          ] as const) {
            const key = await findOnlyNewKey(
              redis,
              keyPatternForIp(ip),
              new Set(),
            );
            assertPrivateBucketKey(key, ip, rawIdentifiers);
            await assertCounterWithTtl(redis, key, count);
            assert.ok((await redis.pttl(key)) <= 60_000);
          }
          for (let userIndex = 0; userIndex < users.length; userIndex += 1) {
            const user = users[userIndex]!;
            const key = await findOnlyNewKey(
              redis,
              keyPatternForAccount(user.userId),
              new Set(),
            );
            const bucket = expectedAccountBucket(user.userId);
            assert.match(bucket, /^account-delete-sha256:[0-9a-f]{64}$/);
            assert.equal(key.endsWith(bucket), true, key);
            assert.ok(key.length <= 256, key);
            assert.equal(await redis.get(key), String([1, 5, 4][userIndex]));
            const ttl = await redis.pttl(key);
            assert.ok(
              ttl > 86_340_000 && ttl <= 86_400_000,
              `unexpected account TTL ${ttl}`,
            );
          }
          const allKeys = await findTestNamespaceKeys(
            redis,
            `${RATE_LIMIT_NAMESPACE}*`,
          );
          for (const identifier of rawIdentifiers) {
            assert.equal(
              allKeys.some((key) => key.includes(identifier)),
              false,
              `raw identifier was stored in a rate-limit key: ${identifier}`,
            );
          }
        }
      } finally {
        try {
          await closeAppResources(resources);
        } finally {
          try {
            await harness?.close();
          } finally {
            if (redis !== undefined) {
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
      }
    },
  );
}
