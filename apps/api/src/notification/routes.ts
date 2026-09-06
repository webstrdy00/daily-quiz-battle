import { UpdateResultNotificationPreferenceRequestSchema } from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { AppError, parseRequest } from "../shared/errors.js";
import { principalKey, rateLimited } from "../shared/rate-limit.js";
import {
  getResultNotificationPreference,
  updateResultNotificationPreference,
} from "./service.js";
import type { NotificationTargetCrypto } from "./target-crypto.js";

export interface NotificationRouteDependencies {
  database: Database;
  tokenService: AccessTokenService;
  targetCrypto: NotificationTargetCrypto;
  anonymousKeyPepper: string;
  notificationDeliveryEnabled: boolean;
  rateLimitEnabled: boolean;
  clock?: () => Date;
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  dependencies: NotificationRouteDependencies,
): void {
  const {
    database,
    tokenService,
    targetCrypto,
    anonymousKeyPepper,
    notificationDeliveryEnabled,
    rateLimitEnabled,
    clock = () => new Date(),
  } = dependencies;

  app.get("/v1/notifications/result-preference", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    return getResultNotificationPreference(
      database,
      principal.userId,
      clock(),
      notificationDeliveryEnabled,
    );
  });

  app.put(
    "/v1/notifications/result-preference",
    rateLimited(rateLimitEnabled, 10, "1 day", principalKey),
    async (request) => {
      const principal = await authenticateRequest(
        request,
        database,
        tokenService,
      );
      const body = parseRequest(
        UpdateResultNotificationPreferenceRequestSchema,
        request.body,
      );
      if (!notificationDeliveryEnabled && body.enabled) {
        throw new AppError({
          statusCode: 503,
          code: "FEATURE_DISABLED",
          message: "현재 결과 알림을 신청할 수 없습니다.",
          retryable: true,
        });
      }
      return updateResultNotificationPreference(
        database,
        targetCrypto,
        anonymousKeyPepper,
        principal.userId,
        body,
        clock(),
        notificationDeliveryEnabled,
      );
    },
  );
}
