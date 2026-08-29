import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  CompleteAttemptResponseSchema,
  DailyStartResponseSchema,
  SubmitAnswerResponseSchema,
  type ApiError,
  type BootstrapResponse,
  type CompleteAttemptResponse,
  type DailyStartResponse,
  type SubmitAnswerRequest,
  type SubmitAnswerResponse,
} from "@daily-quiz-battle/contracts";
import { getAnonymousKey } from "./platform";

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");

let accessToken: string | null = null;

interface Parser<T> {
  parse(value: unknown): T;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(options: {
    code: string;
    message: string;
    retryable?: boolean;
    requestId?: string;
    status?: number;
  }) {
    super(options.message);
    this.name = "ApiClientError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

async function fetchJson<T>(
  path: string,
  parser: Parser<T>,
  init: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new ApiClientError({
      code:
        error instanceof DOMException && error.name === "AbortError"
          ? "REQUEST_TIMEOUT"
          : "NETWORK_ERROR",
      message:
        error instanceof DOMException && error.name === "AbortError"
          ? "응답이 늦어지고 있어요. 다시 시도해 주세요."
          : "네트워크 연결을 확인하고 다시 시도해 주세요.",
      retryable: true,
    });
  } finally {
    window.clearTimeout(timeout);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiClientError({
      code: "INVALID_RESPONSE",
      message: "서버 응답을 처리하지 못했습니다.",
      retryable: response.status >= 500,
      status: response.status,
    });
  }

  if (!response.ok) {
    const parsedError = ApiErrorSchema.safeParse(payload);
    const apiError: ApiError | undefined = parsedError.success
      ? parsedError.data
      : undefined;
    throw new ApiClientError({
      code: apiError?.code ?? "REQUEST_FAILED",
      message: apiError?.message ?? "요청을 처리하지 못했습니다.",
      retryable: apiError?.retryable ?? response.status >= 500,
      requestId: apiError?.requestId,
      status: response.status,
    });
  }

  try {
    return parser.parse(payload);
  } catch {
    throw new ApiClientError({
      code: "INVALID_RESPONSE",
      message: "서버 응답 형식이 올바르지 않습니다.",
      retryable: false,
      status: response.status,
    });
  }
}

export async function bootstrapSession(): Promise<BootstrapResponse> {
  const anonymousKey = await getAnonymousKey();
  const response = await fetchJson(
    "/v1/auth/bootstrap",
    BootstrapResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({ anonymousKey }),
    },
  );
  accessToken = response.accessToken;
  return response;
}

async function authorizedRequest<T>(
  path: string,
  parser: Parser<T>,
  init: RequestInit,
): Promise<T> {
  if (accessToken === null) {
    await bootstrapSession();
  }

  const request = () =>
    fetchJson(path, parser, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${accessToken ?? ""}`,
      },
    });

  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      accessToken = null;
      await bootstrapSession();
      return request();
    }
    throw error;
  }
}

export function createIdempotencyKey(operation: string): string {
  return `${operation}-${crypto.randomUUID()}`;
}

export function startDailyQuiz(): Promise<DailyStartResponse> {
  return authorizedRequest("/v1/daily/start", DailyStartResponseSchema, {
    method: "POST",
    body: "{}",
  });
}

export function submitAnswer(
  attemptId: string,
  answer: SubmitAnswerRequest,
  idempotencyKey: string,
): Promise<SubmitAnswerResponse> {
  return authorizedRequest(
    `/v1/attempts/${encodeURIComponent(attemptId)}/answers`,
    SubmitAnswerResponseSchema,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(answer),
    },
  );
}

export function completeAttempt(
  attemptId: string,
  idempotencyKey: string,
): Promise<CompleteAttemptResponse> {
  return authorizedRequest(
    `/v1/attempts/${encodeURIComponent(attemptId)}/complete`,
    CompleteAttemptResponseSchema,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
    },
  );
}
