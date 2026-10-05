import {
  BootstrapRequestSchema,
  BootstrapResponseSchema,
  RefreshSessionRequestSchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, parseRequest } from "../shared/errors.js";
import { fingerprintAnonymousKey } from "../shared/hash.js";
import { ipKey, rateLimited } from "../shared/rate-limit.js";
import type { IdentityVerifier } from "./identity-verifier.js";
import { generateNickname } from "./nickname.js";
import type { AccessTokenService } from "./token.js";

interface UserRow {
  id: string;
  nickname: string;
  identity_status: "active" | "deleted" | "blocked";
  token_version: number;
}

export interface AuthRouteDependencies {
  config: AppConfig;
  database: Database;
  identityVerifier: IdentityVerifier;
  tokenService: AccessTokenService;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const { config, database, identityVerifier, tokenService } = dependencies;

  app.post(
    "/v1/auth/refresh",
    rateLimited(config.rateLimitEnabled, 30, "10 minutes", ipKey),
    async (request) => {
      const body = parseRequest(RefreshSessionRequestSchema, request.body);
      const fingerprint = fingerprintAnonymousKey(
        body.anonymousKey,
        config.anonymousKeyPepper,
      );
      // Never bootstrap here. Lock the existing identity against deletion while
      // issuing its current token version; later deletion invalidates that token.
      return database.client.begin(async (transaction) => {
        const users = await transaction<UserRow[]>`
          SELECT id, nickname, identity_status, token_version
          FROM users
          WHERE id = ${body.expectedUserId}
            AND anon_key_fingerprint = ${fingerprint}
            AND identity_status = 'active'
          FOR SHARE
        `;
        const user = users[0];
        if (user === undefined) {
          throw new AppError({
            statusCode: 401,
            code: "UNAUTHORIZED",
            message: "기존 계정의 인증 정보를 확인할 수 없습니다.",
          });
        }
        const accessToken = await tokenService.issue({
          userId: user.id,
          tokenVersion: user.token_version,
        });
        return BootstrapResponseSchema.parse({
          accessToken,
          expiresInSeconds: config.accessTokenTtlSeconds,
          user: { id: user.id, nickname: user.nickname },
        });
      });
    },
  );

  app.post(
    "/v1/auth/bootstrap",
    rateLimited(config.rateLimitEnabled, 30, "10 minutes", ipKey),
    async (request) => {
      const body = parseRequest(BootstrapRequestSchema, request.body);
      const fingerprint = fingerprintAnonymousKey(
        body.anonymousKey,
        config.anonymousKeyPepper,
      );

      let users = await database.client<UserRow[]>`
      SELECT id, nickname, identity_status, token_version
      FROM users
      WHERE anon_key_fingerprint = ${fingerprint}
    `;
      let user = users[0];

      if (user === undefined) {
        const valid = await identityVerifier.verify(body.anonymousKey);
        if (!valid) {
          throw new AppError({
            statusCode: 401,
            code: "INVALID_USER_KEY",
            message: "사용자 식별 키를 확인할 수 없습니다.",
          });
        }

        const inserted = await database.client<UserRow[]>`
        INSERT INTO users (
          anon_key_fingerprint,
          nickname,
          identity_verified_at
        )
        VALUES (${fingerprint}, ${generateNickname()}, now())
        ON CONFLICT (anon_key_fingerprint) DO NOTHING
        RETURNING id, nickname, identity_status, token_version
      `;

        user = inserted[0];
        if (user === undefined) {
          users = await database.client<UserRow[]>`
          SELECT id, nickname, identity_status, token_version
          FROM users
          WHERE anon_key_fingerprint = ${fingerprint}
        `;
          user = users[0];
        }
      }

      if (user === undefined || user.identity_status !== "active") {
        throw new AppError({
          statusCode: 403,
          code: "FORBIDDEN",
          message: "현재 사용할 수 없는 사용자입니다.",
        });
      }

      const accessToken = await tokenService.issue({
        userId: user.id,
        tokenVersion: user.token_version,
      });

      return BootstrapResponseSchema.parse({
        accessToken,
        expiresInSeconds: config.accessTokenTtlSeconds,
        user: { id: user.id, nickname: user.nickname },
      });
    },
  );
}
