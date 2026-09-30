import {
  CompleteAttemptRequestSchema,
  IdempotencyKeySchema,
  UuidSchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { AppError, parseRequest } from "../shared/errors.js";
import { principalKey, rateLimited } from "../shared/rate-limit.js";
import { completeAttempt, startDailyQuiz } from "./service.js";

const AttemptParamsSchema = z.object({ attemptId: UuidSchema });

function getIdempotencyKey(request: FastifyRequest): string {
  return parseRequest(IdempotencyKeySchema, request.headers["idempotency-key"]);
}

export interface DailyRouteDependencies {
  database: Database;
  tokenService: AccessTokenService;
  dailyStartEnabled: boolean;
  dailyContinuationEnabled: boolean;
  rateLimitEnabled: boolean;
  notificationDeliveryEnabled?: boolean;
  clock?: () => Date;
}

function requireFeatureEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new AppError({
      statusCode: 503,
      code: "FEATURE_DISABLED",
      message: "현재 이 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      retryable: true,
    });
  }
}

export function registerDailyRoutes(
  app: FastifyInstance,
  dependencies: DailyRouteDependencies,
): void {
  const {
    database,
    tokenService,
    dailyStartEnabled,
    dailyContinuationEnabled,
    rateLimitEnabled,
    notificationDeliveryEnabled = true,
    clock = () => new Date(),
  } = dependencies;

  app.post("/v1/daily/start", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    requireFeatureEnabled(dailyStartEnabled);
    return startDailyQuiz(database, principal.userId, clock());
  });

  app.post(
    "/v1/attempts/:attemptId/complete",
    rateLimited(rateLimitEnabled, 30, "1 minute", principalKey),
    async (request) => {
      const principal = await authenticateRequest(
        request,
        database,
        tokenService,
      );
      requireFeatureEnabled(dailyContinuationEnabled);
      const params = parseRequest(AttemptParamsSchema, request.params);
      const body = parseRequest(CompleteAttemptRequestSchema, request.body);
      const idempotencyKey = getIdempotencyKey(request);

      return completeAttempt(
        database,
        principal.userId,
        params.attemptId,
        idempotencyKey,
        body,
        clock(),
        notificationDeliveryEnabled,
      );
    },
  );
}
