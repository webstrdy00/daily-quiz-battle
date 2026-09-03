import {
  IdempotencyKeySchema,
  SubmitAnswerRequestSchema,
  UuidSchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { parseRequest } from "../shared/errors.js";
import { completeAttempt, startDailyQuiz, submitAnswer } from "./service.js";

const AttemptParamsSchema = z.object({ attemptId: UuidSchema });

function getIdempotencyKey(request: FastifyRequest): string {
  return parseRequest(IdempotencyKeySchema, request.headers["idempotency-key"]);
}

export interface DailyRouteDependencies {
  database: Database;
  tokenService: AccessTokenService;
  clock?: () => Date;
}

export function registerDailyRoutes(
  app: FastifyInstance,
  dependencies: DailyRouteDependencies,
): void {
  const { database, tokenService, clock = () => new Date() } = dependencies;

  app.post("/v1/daily/start", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    return startDailyQuiz(database, principal.userId, clock());
  });

  app.post("/v1/attempts/:attemptId/answers", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    const params = parseRequest(AttemptParamsSchema, request.params);
    const body = parseRequest(SubmitAnswerRequestSchema, request.body);
    const idempotencyKey = getIdempotencyKey(request);

    return submitAnswer(
      database,
      principal.userId,
      params.attemptId,
      idempotencyKey,
      body,
      clock(),
    );
  });

  app.post("/v1/attempts/:attemptId/complete", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    const params = parseRequest(AttemptParamsSchema, request.params);
    const idempotencyKey = getIdempotencyKey(request);

    return completeAttempt(
      database,
      principal.userId,
      params.attemptId,
      idempotencyKey,
      clock(),
    );
  });
}
