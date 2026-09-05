import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  ChallengeLandingResponseSchema,
  ChallengeResultResponseSchema,
  ClaimChallengeResponseSchema,
  CompleteAttemptResponseSchema,
  CreateChallengeResponseSchema,
  CreateQuestionReportRequestSchema,
  CreateReportResponseSchema,
  DailyStartResponseSchema,
  DeleteAccountRequestSchema,
  DeleteAccountResponseSchema,
  ResultNotificationPreferenceResponseSchema,
  SubmitAnswerResponseSchema,
  UpdateResultNotificationPreferenceRequestSchema,
  type ApiError,
  type BootstrapResponse,
  type ChallengeLandingResponse,
  type ChallengeResultResponse,
  type ClaimChallengeResponse,
  type CompleteAttemptResponse,
  type CreateChallengeRequest,
  type CreateChallengeResponse,
  type CreateQuestionReportRequest,
  type CreateReportResponse,
  type DailyStartResponse,
  type DeleteAccountRequest,
  type DeleteAccountResponse,
  type ResultNotificationPreferenceResponse,
  type SubmitAnswerRequest,
  type SubmitAnswerResponse,
} from "@daily-quiz-battle/contracts";
import { getAnonymousKey } from "./platform";

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");

let accessToken: string | null = null;
let sessionEpoch = 0;
let sessionState: "active" | "deleting" | "deleted" | "deletion-uncertain" =
  "active";
let bootstrapPromise: Promise<BootstrapResponse> | null = null;
const inFlightControllers = new Set<AbortController>();

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

export function isDailySetVoidedError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.code === "DAILY_SET_VOIDED";
}

function assertSecureApiEndpoint(): void {
  const endpoint = new URL(apiBaseUrl, window.location.origin);
  const loopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "[::1]" ||
    endpoint.hostname === "::1" ||
    endpoint.hostname.startsWith("127.");

  if (endpoint.protocol !== "https:" && !(import.meta.env.DEV && loopback)) {
    throw new ApiClientError({
      code: "INSECURE_API_ENDPOINT",
      message: "안전한 HTTPS 연결에서만 서버에 요청할 수 있습니다.",
    });
  }
}

function assertActiveSession(epoch = sessionEpoch): void {
  if (sessionState !== "active" || epoch !== sessionEpoch) {
    throw new ApiClientError({
      code: "SESSION_INVALIDATED",
      message: "계정 상태가 변경되어 요청을 중단했습니다.",
    });
  }
}

function abortInFlightRequests(): void {
  for (const controller of inFlightControllers) {
    controller.abort();
  }
  inFlightControllers.clear();
}

async function fetchJson<T>(
  path: string,
  parser: Parser<T>,
  init: RequestInit,
  options: {
    epoch?: number;
    allowDeleting?: boolean;
  } = {},
): Promise<T> {
  assertSecureApiEndpoint();
  const requestEpoch = options.epoch ?? sessionEpoch;
  if (
    requestEpoch !== sessionEpoch ||
    (sessionState !== "active" &&
      !(options.allowDeleting && sessionState === "deleting"))
  ) {
    assertActiveSession(requestEpoch);
  }

  const controller = new AbortController();
  let timedOut = false;
  const handleExternalAbort = () => controller.abort();
  init.signal?.addEventListener("abort", handleExternalAbort, { once: true });
  if (init.signal?.aborted) {
    controller.abort();
  }
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10_000);
  inFlightControllers.add(controller);

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
      code: timedOut
        ? "REQUEST_TIMEOUT"
        : error instanceof DOMException && error.name === "AbortError"
          ? "REQUEST_ABORTED"
          : "NETWORK_ERROR",
      message: timedOut
        ? "응답이 늦어지고 있어요. 다시 시도해 주세요."
        : error instanceof DOMException && error.name === "AbortError"
          ? "요청이 중단되었습니다."
          : "네트워크 연결을 확인하고 다시 시도해 주세요.",
      retryable: timedOut || !(error instanceof DOMException),
    });
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", handleExternalAbort);
    inFlightControllers.delete(controller);
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
  assertActiveSession();
  if (bootstrapPromise !== null) {
    return bootstrapPromise;
  }

  const epoch = sessionEpoch;
  const pending = (async () => {
    const anonymousKey = await getAnonymousKey();
    assertActiveSession(epoch);
    const response = await fetchJson(
      "/v1/auth/bootstrap",
      BootstrapResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ anonymousKey }),
      },
      { epoch },
    );
    assertActiveSession(epoch);
    accessToken = response.accessToken;
    return response;
  })();
  bootstrapPromise = pending;
  try {
    return await pending;
  } finally {
    if (bootstrapPromise === pending) {
      bootstrapPromise = null;
    }
  }
}

async function authorizedRequest<T>(
  path: string,
  parser: Parser<T>,
  init: RequestInit,
): Promise<T> {
  const epoch = sessionEpoch;
  assertActiveSession(epoch);
  if (accessToken === null) {
    await bootstrapSession();
  }
  assertActiveSession(epoch);

  const request = () =>
    fetchJson(
      path,
      parser,
      {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${accessToken ?? ""}`,
        },
      },
      { epoch },
    );

  try {
    const response = await request();
    assertActiveSession(epoch);
    return response;
  } catch (error) {
    if (
      error instanceof ApiClientError &&
      error.status === 401 &&
      sessionState === "active" &&
      epoch === sessionEpoch
    ) {
      accessToken = null;
      await bootstrapSession();
      assertActiveSession(epoch);
      const response = await request();
      assertActiveSession(epoch);
      return response;
    }
    throw error;
  }
}

export function createIdempotencyKey(operation: string): string {
  return `${operation}-${crypto.randomUUID()}`;
}

export function startDailyQuiz(
  signal?: AbortSignal,
): Promise<DailyStartResponse> {
  return authorizedRequest("/v1/daily/start", DailyStartResponseSchema, {
    method: "POST",
    body: "{}",
    signal,
  });
}

export function getResultNotificationPreference(): Promise<ResultNotificationPreferenceResponse> {
  return authorizedRequest(
    "/v1/notifications/result-preference",
    ResultNotificationPreferenceResponseSchema,
    { method: "GET" },
  );
}

export async function updateResultNotificationPreference(
  enabled: boolean,
): Promise<ResultNotificationPreferenceResponse> {
  const anonymousKey = await getAnonymousKey();
  const body = UpdateResultNotificationPreferenceRequestSchema.parse({
    anonymousKey,
    enabled,
  });

  return authorizedRequest(
    "/v1/notifications/result-preference",
    ResultNotificationPreferenceResponseSchema,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );
}

export async function deleteAccount(
  request: DeleteAccountRequest,
): Promise<DeleteAccountResponse> {
  const body = DeleteAccountRequestSchema.parse(request);
  assertActiveSession();
  if (accessToken === null) {
    await bootstrapSession();
  }
  assertActiveSession();

  sessionState = "deleting";
  sessionEpoch += 1;
  const deletionEpoch = sessionEpoch;
  bootstrapPromise = null;
  abortInFlightRequests();

  try {
    const response = await fetchJson(
      "/v1/me",
      DeleteAccountResponseSchema,
      {
        method: "DELETE",
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${accessToken ?? ""}` },
      },
      { epoch: deletionEpoch, allowDeleting: true },
    );
    if (sessionState !== "deleting" || sessionEpoch !== deletionEpoch) {
      throw new ApiClientError({
        code: "SESSION_INVALIDATED",
        message: "계정 상태가 변경되어 요청을 중단했습니다.",
      });
    }
    sessionState = "deleted";
    accessToken = null;
    return response;
  } catch (error) {
    const knownRejection =
      error instanceof ApiClientError &&
      error.status !== undefined &&
      (error.status < 200 || error.status >= 300);

    if (knownRejection) {
      sessionState = "active";
      throw error;
    }

    sessionState = "deletion-uncertain";
    accessToken = null;
    throw new ApiClientError({
      code: "ACCOUNT_DELETION_OUTCOME_UNKNOWN",
      message:
        "계정 삭제 결과를 확인하지 못했어요. 새 사용자가 생성되지 않도록 앱을 완전히 종료한 뒤 다시 시작해 주세요.",
      retryable: false,
      requestId: error instanceof ApiClientError ? error.requestId : undefined,
    });
  }
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
  signal?: AbortSignal,
): Promise<CompleteAttemptResponse> {
  return authorizedRequest(
    `/v1/attempts/${encodeURIComponent(attemptId)}/complete`,
    CompleteAttemptResponseSchema,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
      signal,
    },
  );
}

export function createQuestionReport(
  report: CreateQuestionReportRequest,
  signal?: AbortSignal,
): Promise<CreateReportResponse> {
  const body = CreateQuestionReportRequestSchema.parse(report);

  return authorizedRequest(
    "/v1/reports/questions",
    CreateReportResponseSchema,
    {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function createChallenge(
  challenge: CreateChallengeRequest,
  idempotencyKey: string,
): Promise<CreateChallengeResponse> {
  return authorizedRequest("/v1/challenges", CreateChallengeResponseSchema, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(challenge),
  });
}

export function getChallengeLanding(
  token: string,
  signal?: AbortSignal,
): Promise<ChallengeLandingResponse> {
  return authorizedRequest(
    `/v1/challenges/${encodeURIComponent(token)}`,
    ChallengeLandingResponseSchema,
    { method: "GET", signal },
  );
}

export function claimChallenge(
  token: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ClaimChallengeResponse> {
  return authorizedRequest(
    `/v1/challenges/${encodeURIComponent(token)}/claim`,
    ClaimChallengeResponseSchema,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
      signal,
    },
  );
}

export function getChallengeResult(
  token: string,
  signal?: AbortSignal,
): Promise<ChallengeResultResponse> {
  return authorizedRequest(
    `/v1/challenges/${encodeURIComponent(token)}/result`,
    ChallengeResultResponseSchema,
    { method: "GET", signal },
  );
}
