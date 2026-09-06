import { OperationalCapabilitiesResponseSchema } from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";

export interface OperationalCapabilitiesRouteDependencies {
  database: Database;
  tokenService: AccessTokenService;
  analyticsPublishEnabled: boolean;
}

export function registerOperationalCapabilitiesRoutes(
  app: FastifyInstance,
  dependencies: OperationalCapabilitiesRouteDependencies,
): void {
  const { database, tokenService, analyticsPublishEnabled } = dependencies;

  app.get("/v1/operational-capabilities", async (request) => {
    await authenticateRequest(request, database, tokenService);
    return OperationalCapabilitiesResponseSchema.parse({
      analyticsPublishEnabled,
    });
  });
}
