import { jwtVerify, SignJWT } from "jose";
import type { AppConfig } from "../config.js";
import { AppError } from "../shared/errors.js";

const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const ADMIN_ACCESS_TOKEN_SCOPES = [
  "content:write",
  "content:void",
  "reports:read",
  "reports:triage",
] as const;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export function isValidAdminSubject(subject: unknown): subject is string {
  return (
    typeof subject === "string" &&
    subject === subject.trim() &&
    subject.length > 0 &&
    Array.from(subject).length <= 100 &&
    !CONTROL_CHARACTER_PATTERN.test(subject)
  );
}

export function isValidAdminScopes(scopes: unknown): scopes is string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return false;
  }
  for (const scope of scopes) {
    if (
      typeof scope !== "string" ||
      !ADMIN_ACCESS_TOKEN_SCOPES.some((allowed) => allowed === scope)
    ) {
      return false;
    }
  }
  return new Set(scopes).size === scopes.length;
}

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
      if (
        !isValidAdminSubject(principal.actorSubject) ||
        !isValidAdminScopes(principal.scopes)
      ) {
        throw new Error("Admin access token principal is invalid");
      }
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
          !isValidAdminSubject(payload.sub) ||
          typeof payload.iat !== "number" ||
          !Number.isInteger(payload.iat) ||
          typeof payload.exp !== "number" ||
          !Number.isInteger(payload.exp) ||
          payload.iat > now ||
          payload.exp <= payload.iat ||
          payload.exp - payload.iat > ADMIN_ACCESS_TOKEN_TTL_SECONDS ||
          !isValidAdminScopes(payload.scope)
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
