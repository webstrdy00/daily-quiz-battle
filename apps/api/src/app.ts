import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { registerAccountRoutes } from "./account/routes.js";
import { registerAdminContentRoutes } from "./admin/content-routes.js";
import { createAdminAccessTokenService } from "./admin/token.js";
import { createIdentityVerifier } from "./auth/identity-verifier.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { createAccessTokenService } from "./auth/token.js";
import type { AppConfig } from "./config.js";
import { registerChallengeRoutes } from "./challenge/routes.js";
import { createChallengeTokenService } from "./challenge/token.js";
import { registerDailyRoutes } from "./daily/routes.js";
import type { Database } from "./db/client.js";
import { registerNotificationRoutes } from "./notification/routes.js";
import { createNotificationTargetCrypto } from "./notification/target-crypto.js";
import { registerReportRoutes } from "./report/routes.js";
import { AppError, sendError } from "./shared/errors.js";
import { registerRateLimit } from "./shared/rate-limit.js";

export interface BuildAppOptions {
  config: AppConfig;
  database: Database;
  clock?: () => Date;
}

export async function buildApp({
  config,
  database,
  clock,
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
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: "x-request-id",
  });

  await app.register(cors, {
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "accept",
      "authorization",
      "content-type",
      "idempotency-key",
      "x-request-id",
    ],
    exposedHeaders: ["x-request-id"],
    origin(origin, callback) {
      if (origin === undefined || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });

  await registerRateLimit(app);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-request-id", request.id);
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
  const adminTokenService = createAdminAccessTokenService(config);
  const notificationTargetCrypto = createNotificationTargetCrypto({
    key: config.notificationTargetEncryptionKey,
    version: config.notificationTargetEncryptionKeyVersion,
    previous:
      config.notificationTargetEncryptionKeyPrevious !== undefined &&
      config.notificationTargetEncryptionKeyVersionPrevious !== undefined
        ? {
            key: config.notificationTargetEncryptionKeyPrevious,
            version: config.notificationTargetEncryptionKeyVersionPrevious,
          }
        : undefined,
  });

  registerAuthRoutes(app, {
    config,
    database,
    identityVerifier,
    tokenService,
  });
  registerAccountRoutes(app, {
    database,
    tokenService,
    rateLimitEnabled: config.rateLimitEnabled,
    clock,
  });
  registerAdminContentRoutes(app, {
    database,
    tokenService: adminTokenService,
    clock,
  });
  registerDailyRoutes(app, {
    database,
    tokenService,
    rateLimitEnabled: config.rateLimitEnabled,
    clock,
  });
  registerReportRoutes(app, {
    database,
    tokenService,
    rateLimitEnabled: config.rateLimitEnabled,
    clock,
  });
  registerNotificationRoutes(app, {
    database,
    tokenService,
    targetCrypto: notificationTargetCrypto,
    anonymousKeyPepper: config.anonymousKeyPepper,
    rateLimitEnabled: config.rateLimitEnabled,
    clock,
  });
  registerChallengeRoutes(app, {
    database,
    tokenService,
    challengeTokens: createChallengeTokenService({
      secret: config.challengeTokenSecret,
      previousSecret: config.challengeTokenSecretPrevious,
    }),
    rateLimitEnabled: config.rateLimitEnabled,
    clock,
  });

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

    // Fastify client-side failures (malformed/empty JSON, oversized body,
    // unsupported media type) carry a 4xx statusCode and must not surface as 500.
    const clientStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    if (
      clientStatus !== undefined &&
      clientStatus >= 400 &&
      clientStatus < 500
    ) {
      sendError(
        new AppError({
          statusCode: clientStatus === 415 ? 415 : 400,
          code: "INVALID_REQUEST",
          message: "요청 형식이 올바르지 않습니다.",
        }),
        request,
        reply,
      );
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
