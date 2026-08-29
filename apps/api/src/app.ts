import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import { createIdentityVerifier } from "./auth/identity-verifier.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { createAccessTokenService } from "./auth/token.js";
import type { AppConfig } from "./config.js";
import { registerDailyRoutes } from "./daily/routes.js";
import type { Database } from "./db/client.js";
import { AppError, sendError } from "./shared/errors.js";

export interface BuildAppOptions {
  config: AppConfig;
  database: Database;
}

export async function buildApp({
  config,
  database,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-anon-key",
          "req.body.anonymousKey",
          "request.headers.authorization",
          "request.headers.x-anon-key",
          "request.body.anonymousKey",
        ],
        censor: "[REDACTED]",
      },
    },
    disableRequestLogging: true,
    requestIdHeader: "x-request-id",
  });

  await app.register(cors, {
    credentials: false,
    origin(origin, callback) {
      if (origin === undefined || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "request completed",
    );
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await database.client`SELECT 1`;
      return { status: "ready" };
    } catch (error) {
      app.log.error({ err: error }, "readiness check failed");
      return reply.status(503).send({ status: "not-ready" });
    }
  });

  const identityVerifier = createIdentityVerifier(config);
  const tokenService = createAccessTokenService(config);

  registerAuthRoutes(app, {
    config,
    database,
    identityVerifier,
    tokenService,
  });
  registerDailyRoutes(app, { database, tokenService });

  app.setNotFoundHandler((request, reply) => {
    sendError(
      new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: "요청한 리소스를 찾을 수 없습니다.",
      }),
      request,
      reply,
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      sendError(error, request, reply);
      return;
    }

    request.log.error(
      {
        err: error,
        route: request.routeOptions.url,
      },
      "unhandled request error",
    );
    sendError(
      new AppError({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "요청을 처리하지 못했습니다.",
      }),
      request,
      reply,
    );
  });

  app.addHook("onClose", async () => {
    await database.close();
  });

  return app;
}
