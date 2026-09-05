import { UpdateResultNotificationPreferenceRequestSchema } from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { parseRequest } from "../shared/errors.js";
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
    rateLimitEnabled,
    clock = () => new Date(),
  } = dependencies;

  app.get("/v1/notifications/result-preference", async (request) => {
    const principal = await authenticateRequest(
      request,
      database,
      tokenService,
    );
    return getResultNotificationPreference(database, principal.userId, clock());
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
      return updateResultNotificationPreference(
        database,
        targetCrypto,
        anonymousKeyPepper,
        principal.userId,
        body,
        clock(),
      );
    },
  );
}
