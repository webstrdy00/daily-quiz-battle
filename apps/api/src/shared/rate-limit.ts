import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import type {
  FastifyInstance,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify";
import { Redis } from "ioredis";
import { AppError } from "./errors.js";

const RATE_LIMIT_NAMESPACE = "daily-quiz-battle:rate-limit:";
const IP_BUCKET_HASH_DOMAIN = "daily-quiz-battle:rate-limit:ip:v1\0";

export interface RegisterRateLimitOptions {
  redisUrl?: string;
  requireRedis: boolean;
}

function preAuthIpBucket(request: FastifyRequest): string {
  const digest = createHash("sha256")
    .update(IP_BUCKET_HASH_DOMAIN, "utf8")
    .update(request.ip, "utf8")
    .digest("hex");
  return `ip-sha256:${digest}`;
}

/**
 * Rate-limit hooks run before handler authentication, so these compatibility
 * exports deliberately ignore bearer claims and use a fixed-length hashed IP
 * bucket. This prevents forged `sub` rotation from splitting the bucket, at
 * the cost of grouping legitimate clients that share a NAT address.
 */
export function principalKey(request: FastifyRequest): string {
  return preAuthIpBucket(request);
}

export function ipKey(request: FastifyRequest): string {
  return preAuthIpBucket(request);
}

export function ipAndPrincipalKey(request: FastifyRequest): string {
  return preAuthIpBucket(request);
}

export function rateLimited(
  enabled: boolean,
  max: number,
  timeWindow: string,
  keyGenerator: (request: FastifyRequest) => string,
): RouteShorthandOptions {
  if (!enabled) {
    return {};
  }
  return { config: { rateLimit: { max, timeWindow, keyGenerator } } };
}

async function closeRedis(app: FastifyInstance, redis: Redis): Promise<void> {
  if (redis.status === "end") {
    return;
  }

  try {
    await redis.quit();
  } catch (error) {
    redis.disconnect(false);
    app.log.warn({ err: error }, "rate limit Redis connection disconnected");
  }
}

async function connectRedis(
  app: FastifyInstance,
  options: RegisterRateLimitOptions,
): Promise<Redis | undefined> {
  if (options.redisUrl === undefined) {
    if (options.requireRedis) {
      throw new Error("Shared rate limit Redis store is required");
    }
    return undefined;
  }

  const redis = new Redis(options.redisUrl, {
    connectionName: "daily-quiz-battle-rate-limit",
    connectTimeout: 5_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", (error: Error) => {
    app.log.error({ err: error }, "rate limit Redis connection error");
  });

  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch (error) {
    redis.disconnect(false);
    if (options.requireRedis) {
      throw new Error("Failed to initialize shared rate limit store", {
        cause: error,
      });
    }
    app.log.warn(
      "Failed to initialize rate limit Redis; using in-memory store",
    );
    return undefined;
  }
}

/**
 * Global limit is disabled; routes opt in via `rateLimited(...)`. Development
 * can use the plugin's in-memory store, while non-development instances share
 * the Redis-backed store.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  options: RegisterRateLimitOptions,
): Promise<void> {
  const redis = await connectRedis(app, options);

  try {
    await app.register(rateLimit, {
      global: false,
      nameSpace: RATE_LIMIT_NAMESPACE,
      redis,
      skipOnError: false,
      errorResponseBuilder(_request, context) {
        return new AppError({
          statusCode: 429,
          code: "RATE_LIMITED",
          message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
          retryable: true,
          details: { retryAfterMs: context.ttl },
        });
      },
    });
  } catch (error) {
    if (redis !== undefined) {
      await closeRedis(app, redis);
    }
    throw error;
  }

  if (redis !== undefined) {
    app.addHook("onClose", async () => {
      await closeRedis(app, redis);
    });
  }
}
