import {
  ChallengeTokenSchema,
  CreateChallengeRequestSchema,
  IdempotencyKeySchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { AppError, parseRequest } from "../shared/errors.js";
import {
  ipAndPrincipalKey,
  principalKey,
  rateLimited,
} from "../shared/rate-limit.js";
import {
  claimChallenge,
  createChallenge,
  getChallengeLanding,
  getChallengeResult,
} from "./service.js";
import type { ChallengeTokenService } from "./token.js";

const TokenParamsSchema = z.object({ token: ChallengeTokenSchema });

export interface ChallengeRouteDependencies {
  database: Database;
  tokenService: AccessTokenService;
  challengeTokens: ChallengeTokenService;
  challengeCreateEnabled: boolean;
  challengeClaimEnabled: boolean;
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

function getIdempotencyKey(request: FastifyRequest): string {
  return parseRequest(IdempotencyKeySchema, request.headers["idempotency-key"]);
}

function tokenParam(request: FastifyRequest): string {
  return parseRequest(TokenParamsSchema, request.params).token;
}

export function registerChallengeRoutes(
  app: FastifyInstance,
  dependencies: ChallengeRouteDependencies,
): void {
  const {
    database,
    tokenService,
    challengeTokens,
    challengeCreateEnabled,
    challengeClaimEnabled,
    rateLimitEnabled,
    notificationDeliveryEnabled = true,
    clock = () => new Date(),
  } = dependencies;

  app.post(
    "/v1/challenges",
    rateLimited(rateLimitEnabled, 10, "10 minutes", principalKey),
    async (request) => {
      const principal = await authenticateRequest(
        request,
        database,
        tokenService,
      );
      requireFeatureEnabled(challengeCreateEnabled);
      const body = parseRequest(CreateChallengeRequestSchema, request.body);
      const idempotencyKey = getIdempotencyKey(request);
      return createChallenge(
        database,
        challengeTokens,
        principal.userId,
        body.attemptId,
        idempotencyKey,
        clock(),
      );
    },
  );

  app.get("/v1/challenges/:token", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    return getChallengeLanding(
      database,
      challengeTokens,
      principal.userId,
      tokenParam(request),
      clock(),
    );
  });

  app.post(
    "/v1/challenges/:token/claim",
    rateLimited(rateLimitEnabled, 20, "10 minutes", ipAndPrincipalKey),
    async (request) => {
      const principal = await authenticateRequest(
        request,
        database,
        tokenService,
      );
      requireFeatureEnabled(challengeClaimEnabled);
      // Contract requires the header; claim is idempotent per (challenge,
      // user) so only well-formedness is checked.
      getIdempotencyKey(request);
      return claimChallenge(
        database,
        challengeTokens,
        principal.userId,
        tokenParam(request),
        clock(),
        notificationDeliveryEnabled,
      );
    },
  );

  app.get("/v1/challenges/:token/result", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    return getChallengeResult(
      database,
      challengeTokens,
      principal.userId,
      tokenParam(request),
      clock(),
    );
  });
}
