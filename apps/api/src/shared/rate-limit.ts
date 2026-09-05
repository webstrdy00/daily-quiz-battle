import rateLimit from "@fastify/rate-limit";
import type {
  FastifyInstance,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify";
import { AppError } from "./errors.js";

/**
 * Bucket key: bearer subject when present so abuse is attributed per user,
 * IP otherwise. The token is fully verified inside the handler; here we
 * only need a stable, cheap key. A forged `sub` only isolates the forger.
 */
export function principalKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const payload = authorization.slice("Bearer ".length).split(".")[1];
    if (payload !== undefined) {
      try {
        const decoded = JSON.parse(
          Buffer.from(payload, "base64url").toString("utf8"),
        ) as { sub?: unknown };
        if (typeof decoded.sub === "string" && decoded.sub.length > 0) {
          return `user:${decoded.sub}`;
        }
      } catch {
        // malformed token → IP bucket
      }
    }
  }
  return `ip:${request.ip}`;
}

export function ipKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

export function ipAndPrincipalKey(request: FastifyRequest): string {
  return `${request.ip}|${principalKey(request)}`;
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

/**
 * In-memory limiter (05 §6): fine for a single local/staging instance,
 * must be swapped for a shared store before multi-instance production.
 * Global limit is disabled; routes opt in via `rateLimited(...)`.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder(request, context) {
      const error = new AppError({
        statusCode: 429,
        code: "RATE_LIMITED",
        message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        retryable: true,
        details: { retryAfterMs: context.ttl },
      });
      return {
        code: error.code,
        message: error.message,
        requestId: request.id,
        retryable: error.retryable,
        details: error.details,
      };
    },
  });
}
