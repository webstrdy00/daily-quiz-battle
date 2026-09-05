import { jwtVerify, SignJWT } from "jose";
import type { AppConfig } from "../config.js";
import { AppError } from "../shared/errors.js";

const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AdminAccessTokenPrincipal {
  actorSubject: string;
  scopes: string[];
}

export interface AdminAccessTokenService {
  issue(principal: AdminAccessTokenPrincipal): Promise<string>;
  verify(token: string): Promise<AdminAccessTokenPrincipal>;
}

export function createAdminAccessTokenService(
  config: AppConfig,
): AdminAccessTokenService {
  const secret = new TextEncoder().encode(config.adminAccessTokenSecret);

  return {
    async issue(principal) {
      const issuedAt = Math.floor(Date.now() / 1000);

      return new SignJWT({ scope: principal.scopes })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(principal.actorSubject)
        .setIssuer(config.adminAccessTokenIssuer)
        .setAudience(config.adminAccessTokenAudience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ADMIN_ACCESS_TOKEN_TTL_SECONDS)
        .sign(secret);
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, {
          issuer: config.adminAccessTokenIssuer,
          audience: config.adminAccessTokenAudience,
          algorithms: ["HS256"],
        });
        const now = Math.floor(Date.now() / 1000);

        if (
          typeof payload.sub !== "string" ||
          payload.sub.length === 0 ||
          typeof payload.iat !== "number" ||
          !Number.isInteger(payload.iat) ||
          typeof payload.exp !== "number" ||
          !Number.isInteger(payload.exp) ||
          payload.iat > now ||
          payload.exp <= payload.iat ||
          payload.exp - payload.iat > ADMIN_ACCESS_TOKEN_TTL_SECONDS ||
          !Array.isArray(payload.scope) ||
          !payload.scope.every(
            (scope): scope is string =>
              typeof scope === "string" && scope.length > 0,
          )
        ) {
          throw new Error("Admin access token payload is invalid");
        }

        return {
          actorSubject: payload.sub,
          scopes: payload.scope,
        };
      } catch {
        throw new AppError({
          statusCode: 401,
          code: "ADMIN_UNAUTHORIZED",
          message: "관리자 인증이 필요합니다.",
        });
      }
    },
  };
}
