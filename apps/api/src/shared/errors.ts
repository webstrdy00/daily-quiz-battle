import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    statusCode: number;
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "AppError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function parseRequest<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw new AppError({
    statusCode: 400,
    code: "INVALID_REQUEST",
    message: "요청 형식이 올바르지 않습니다.",
    details: {
      fields: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    },
  });
}

export function sendError(
  error: AppError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  void reply.status(error.statusCode).send({
    code: error.code,
    message: error.message,
    requestId: request.id,
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}
