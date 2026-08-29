import { jwtVerify, SignJWT } from "jose";
import type { AppConfig } from "../config.js";
import { AppError } from "../shared/errors.js";

export interface AccessTokenPrincipal {
  userId: string;
  tokenVersion: number;
}

export interface AccessTokenService {
  issue(principal: AccessTokenPrincipal): Promise<string>;
  verify(token: string): Promise<AccessTokenPrincipal>;
}

export function createAccessTokenService(
  config: AppConfig,
): AccessTokenService {
  const secret = new TextEncoder().encode(config.accessTokenSecret);

  return {
    async issue(principal) {
      return new SignJWT({ tokenVersion: principal.tokenVersion })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(principal.userId)
        .setIssuer(config.accessTokenIssuer)
        .setAudience(config.accessTokenAudience)
        .setIssuedAt()
        .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
        .sign(secret);
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, {
          issuer: config.accessTokenIssuer,
          audience: config.accessTokenAudience,
          algorithms: ["HS256"],
        });

        if (
          payload.sub === undefined ||
          typeof payload.tokenVersion !== "number" ||
          !Number.isInteger(payload.tokenVersion)
        ) {
          throw new Error("Access token payload is incomplete");
        }

        return {
          userId: payload.sub,
          tokenVersion: payload.tokenVersion,
        };
      } catch {
        throw new AppError({
          statusCode: 401,
          code: "UNAUTHORIZED",
          message: "인증이 만료되었거나 올바르지 않습니다.",
        });
      }
    },
  };
}
