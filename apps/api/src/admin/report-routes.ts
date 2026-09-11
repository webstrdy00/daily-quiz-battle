import {
  AdminListReportsQuerySchema,
  AdminUpdateReportStatusRequestSchema,
  UuidSchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { parseRequest } from "../shared/errors.js";
import { authenticateAdminRequest } from "./authenticate.js";
import { listReports, updateReportStatus } from "./report-service.js";
import type { AdminAccessTokenService } from "./token.js";

const ReportParamsSchema = z.object({ reportId: UuidSchema }).strict();

export interface AdminReportRouteDependencies {
  database: Database;
  tokenService: AdminAccessTokenService;
  clock?: () => Date;
}

export function registerAdminReportRoutes(
  app: FastifyInstance,
  dependencies: AdminReportRouteDependencies,
): void {
  const { database, tokenService, clock = () => new Date() } = dependencies;

  app.get("/v1/admin/reports", async (request) => {
    await authenticateAdminRequest(request, tokenService, "reports:read");
    const query = parseRequest(AdminListReportsQuerySchema, request.query);
    return listReports(database, query);
  });

  app.patch("/v1/admin/reports/:reportId/status", async (request) => {
    const principal = await authenticateAdminRequest(
      request,
      tokenService,
      "reports:triage",
    );
    const params = parseRequest(ReportParamsSchema, request.params);
    const body = parseRequest(
      AdminUpdateReportStatusRequestSchema,
      request.body,
    );
    return updateReportStatus(
      database,
      principal.actorSubject,
      params.reportId,
      body.status,
      clock(),
    );
  });
}
