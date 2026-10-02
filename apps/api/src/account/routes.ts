import { DeleteAccountRequestSchema } from "@daily-quiz-battle/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { AppError, parseRequest } from "../shared/errors.js";
import {
  accountDeletionKey,
  ipKey,
  rateLimited,
} from "../shared/rate-limit.js";
import { deleteAccount } from "./service.js";

export interface AccountRouteDependencies {
  database: Database;
  tokenService: AccessTokenService;
  rateLimitEnabled: boolean;
  clock?: () => Date;
}

export function registerAccountRoutes(
  app: FastifyInstance,
  dependencies: AccountRouteDependencies,
): void {
  const {
    database,
    tokenService,
    rateLimitEnabled,
    clock = () => new Date(),
  } = dependencies;

  const verifiedUsers = new WeakMap<FastifyRequest, string>();
  // createRateLimit runs independently of the pre-auth hook's per-request flag.
  const checkAccountLimit = rateLimitEnabled
    ? app.createRateLimit({
        max: 3,
        timeWindow: "1 day",
        keyGenerator(request) {
          const userId = verifiedUsers.get(request);
          if (userId === undefined)
            throw new Error("Account deletion limit requires authentication");
          return accountDeletionKey(userId);
        },
      })
    : undefined;

  app.delete(
    "/v1/me",
    rateLimited(rateLimitEnabled, 60, "1 minute", ipKey),
    async (request, reply) => {
      const principal = await authenticateRequest(
        request,
        database,
        tokenService,
      );
      if (checkAccountLimit !== undefined) {
        verifiedUsers.set(request, principal.userId);
        try {
          const limit = await checkAccountLimit(request);
          if (!limit.isAllowed) {
            reply.header("x-ratelimit-limit", limit.max);
            reply.header("x-ratelimit-remaining", limit.remaining);
            reply.header("x-ratelimit-reset", limit.ttlInSeconds);
            if (limit.isExceeded) {
              reply.header("retry-after", limit.ttlInSeconds);
              throw new AppError({
                statusCode: 429,
                code: "RATE_LIMITED",
                message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
                retryable: true,
                details: { retryAfterMs: limit.ttl },
              });
            }
          }
        } finally {
          verifiedUsers.delete(request);
        }
      }
      parseRequest(DeleteAccountRequestSchema, request.body);
      return deleteAccount(database, principal.userId, clock());
    },
  );
}
