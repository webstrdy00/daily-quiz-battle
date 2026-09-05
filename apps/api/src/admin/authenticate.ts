import type { FastifyRequest } from "fastify";
import { AppError } from "../shared/errors.js";
import type { AdminAccessTokenService } from "./token.js";

const CONTENT_WRITE_SCOPE = "content:write";
export type AdminContentScope = "content:write" | "content:void";

export interface AuthenticatedAdminPrincipal {
  actorSubject: string;
}

export async function authenticateAdminRequest(
  request: FastifyRequest,
  tokenService: AdminAccessTokenService,
  requiredScope: AdminContentScope = CONTENT_WRITE_SCOPE,
): Promise<AuthenticatedAdminPrincipal> {
  const authorization = request.headers.authorization;
  const match =
    authorization === undefined
      ? null
      : /^Bearer ([^\s]+)$/.exec(authorization);

  if (match === null || match[1] === undefined) {
    throw new AppError({
      statusCode: 401,
      code: "ADMIN_UNAUTHORIZED",
      message: "관리자 인증이 필요합니다.",
    });
  }

  let tokenPrincipal;
  try {
    tokenPrincipal = await tokenService.verify(match[1]);
  } catch {
    throw new AppError({
      statusCode: 401,
      code: "ADMIN_UNAUTHORIZED",
      message: "관리자 인증이 필요합니다.",
    });
  }

  if (!tokenPrincipal.scopes.includes(requiredScope)) {
    throw new AppError({
      statusCode: 403,
      code: "ADMIN_FORBIDDEN",
      message: "콘텐츠를 변경할 권한이 없습니다.",
    });
  }

  return { actorSubject: tokenPrincipal.actorSubject };
}
