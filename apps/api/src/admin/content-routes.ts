import {
  AdminCreateDailySetDraftRequestSchema,
  AdminCreateQuestionRevisionRequestSchema,
  AdminUpdateQuestionRevisionStatusRequestSchema,
  UuidSchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { parseRequest } from "../shared/errors.js";
import { authenticateAdminRequest } from "./authenticate.js";
import {
  createDailySetDraft,
  createQuestionRevision,
  publishDailySet,
  updateQuestionRevisionStatus,
} from "./content-service.js";
import type { AdminAccessTokenService } from "./token.js";

const RevisionParamsSchema = z.object({ id: UuidSchema });
const DailySetParamsSchema = z.object({ id: UuidSchema });

export interface AdminContentRouteDependencies {
  database: Database;
  tokenService: AdminAccessTokenService;
  clock?: () => Date;
}

export function registerAdminContentRoutes(
  app: FastifyInstance,
  dependencies: AdminContentRouteDependencies,
): void {
  const { database, tokenService, clock = () => new Date() } = dependencies;

  app.post("/v1/admin/content/question-revisions", async (request) => {
    const principal = await authenticateAdminRequest(request, tokenService);
    const body = parseRequest(
      AdminCreateQuestionRevisionRequestSchema,
      request.body,
    );
    return createQuestionRevision(database, principal.actorSubject, body);
  });

  app.patch(
    "/v1/admin/content/question-revisions/:id/status",
    async (request) => {
      const principal = await authenticateAdminRequest(request, tokenService);
      const params = parseRequest(RevisionParamsSchema, request.params);
      const body = parseRequest(
        AdminUpdateQuestionRevisionStatusRequestSchema,
        request.body,
      );
      return updateQuestionRevisionStatus(
        database,
        principal.actorSubject,
        params.id,
        body.status,
        clock(),
      );
    },
  );

  app.post("/v1/admin/content/daily-sets", async (request) => {
    const principal = await authenticateAdminRequest(request, tokenService);
    const body = parseRequest(
      AdminCreateDailySetDraftRequestSchema,
      request.body,
    );
    return createDailySetDraft(database, principal.actorSubject, body);
  });

  app.post("/v1/admin/content/daily-sets/:id/publish", async (request) => {
    const principal = await authenticateAdminRequest(request, tokenService);
    const params = parseRequest(DailySetParamsSchema, request.params);
    return publishDailySet(
      database,
      principal.actorSubject,
      params.id,
      clock(),
    );
  });
}
