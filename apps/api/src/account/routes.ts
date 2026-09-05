import { DeleteAccountRequestSchema } from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { parseRequest } from "../shared/errors.js";
import { principalKey, rateLimited } from "../shared/rate-limit.js";
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

  app.delete(
    "/v1/me",
    rateLimited(rateLimitEnabled, 3, "1 day", principalKey),
    async (request) => {
      const principal = await authenticateRequest(
        request,
        database,
        tokenService,
      );
      parseRequest(DeleteAccountRequestSchema, request.body);
      return deleteAccount(database, principal.userId, clock());
    },
  );
}
