import { CreateQuestionReportRequestSchema } from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "../auth/authenticate.js";
import type { AccessTokenService } from "../auth/token.js";
import type { Database } from "../db/client.js";
import { parseRequest } from "../shared/errors.js";
import { principalKey, rateLimited } from "../shared/rate-limit.js";
import { createQuestionReport } from "./service.js";

export interface ReportRouteDependencies {
  database: Database;
  tokenService: AccessTokenService;
  rateLimitEnabled: boolean;
  clock?: () => Date;
}

export function registerReportRoutes(
  app: FastifyInstance,
  dependencies: ReportRouteDependencies,
): void {
  const {
    database,
    tokenService,
    rateLimitEnabled,
    clock = () => new Date(),
  } = dependencies;

  app.post(
    "/v1/reports/questions",
    rateLimited(rateLimitEnabled, 10, "1 hour", principalKey),
    async (request) => {
      const principal = await authenticateRequest(
        request,
        database,
        tokenService,
      );
      const body = parseRequest(
        CreateQuestionReportRequestSchema,
        request.body,
      );
      return createQuestionReport(database, principal.userId, body, clock());
    },
  );
}
