import type { FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";
import type { AccessTokenService } from "./token.js";

export interface AuthenticatedPrincipal {
  userId: string;
}

interface UserIdentityRow {
  id: string;
  identity_status: "active" | "deleted" | "blocked";
  token_version: number;
}

export async function authenticateRequest(
  request: FastifyRequest,
  database: Database,
  tokenService: AccessTokenService,
): Promise<AuthenticatedPrincipal> {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new AppError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "인증이 필요합니다.",
    });
  }

  const token = authorization.slice("Bearer ".length);
  const tokenPrincipal = await tokenService.verify(token);
  const rows = await database.client<UserIdentityRow[]>`
    SELECT id, identity_status, token_version
    FROM users
    WHERE id = ${tokenPrincipal.userId}
  `;
  const user = rows[0];

  if (
    user === undefined ||
    user.identity_status !== "active" ||
    user.token_version !== tokenPrincipal.tokenVersion
  ) {
    throw new AppError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "현재 사용할 수 없는 인증입니다.",
    });
  }

  return { userId: user.id };
}
