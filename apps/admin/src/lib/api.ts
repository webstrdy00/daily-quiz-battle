import {
  AdminCreateDailySetDraftRequestSchema,
  AdminCreateDailySetDraftResponseSchema,
  AdminCreateQuestionRevisionRequestSchema,
  AdminCreateQuestionRevisionResponseSchema,
  AdminListAuditLogsQuerySchema,
  AdminListAuditLogsResponseSchema,
  AdminListDailySetsQuerySchema,
  AdminListDailySetsResponseSchema,
  AdminListQuestionRevisionsQuerySchema,
  AdminListQuestionRevisionsResponseSchema,
  AdminPublishDailySetResponseSchema,
  AdminUpdateQuestionRevisionStatusRequestSchema,
  AdminUpdateQuestionRevisionStatusResponseSchema,
  AdminVoidDailySetRequestSchema,
  AdminVoidDailySetResponseSchema,
  ApiErrorSchema,
  UuidSchema,
  type AdminContentCursor,
  type AdminCreateDailySetDraftRequest,
  type AdminCreateDailySetDraftResponse,
  type AdminCreateQuestionRevisionRequest,
  type AdminCreateQuestionRevisionResponse,
  type AdminListAuditLogsResponse,
  type AdminListDailySetsQuery,
  type AdminListDailySetsResponse,
  type AdminListQuestionRevisionsResponse,
  type AdminPublishDailySetResponse,
  type AdminUpdateQuestionRevisionStatusRequest,
  type AdminUpdateQuestionRevisionStatusResponse,
  type AdminVoidDailySetRequest,
  type AdminVoidDailySetResponse,
  type ContentStatus,
} from "@daily-quiz-battle/contracts";

interface Parser<T> {
  parse(value: unknown): T;
}

export interface QuestionRevisionQuery {
  status?: ContentStatus;
  cursor?: AdminContentCursor;
  limit?: number;
}

export interface AuditLogQuery {
  cursor?: AdminContentCursor;
  limit?: number;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(options: {
    code: string;
    message: string;
    requestId?: string;
    retryable?: boolean;
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

function resolveApiBaseUrl(): string {
  const configured = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!configured && !import.meta.env.DEV) {
    throw new ApiClientError({
      code: "ADMIN_API_NOT_CONFIGURED",
      message: "운영자 API 주소가 설정되지 않았습니다.",
    });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(
      configured || "http://127.0.0.1:3000",
      window.location.origin,
    );
  } catch {
    throw new ApiClientError({
      code: "ADMIN_API_INVALID_URL",
      message: "운영자 API 주소가 올바르지 않습니다.",
    });
  }

  const loopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "[::1]" ||
    endpoint.hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);

  if (endpoint.protocol !== "https:" && !(import.meta.env.DEV && loopback)) {
    throw new ApiClientError({
      code: "INSECURE_ADMIN_API_ENDPOINT",
      message: "운영자 API는 HTTPS로만 연결할 수 있습니다.",
    });
  }

  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new ApiClientError({
      code: "ADMIN_API_INVALID_URL",
      message:
        "운영자 API 주소에 인증 정보, 쿼리 또는 해시를 포함할 수 없습니다.",
    });
  }

  return endpoint.toString().replace(/\/$/, "");
}

function invalidRequest(): ApiClientError {
  return new ApiClientError({
    code: "INVALID_REQUEST",
    message: "입력값을 다시 확인해 주세요.",
  });
}

export class AdminApiClient {
  private token: string;
  private readonly baseUrl: string;
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  constructor(token: string) {
    if (!token.trim()) {
      throw new ApiClientError({
        code: "ADMIN_TOKEN_REQUIRED",
        message: "15분 운영자 JWT를 입력해 주세요.",
      });
    }
    this.token = token.trim();
    this.baseUrl = resolveApiBaseUrl();
  }

  dispose(): void {
    this.disposed = true;
    this.token = "";
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }

  async listQuestionRevisions(
    query: QuestionRevisionQuery = {},
  ): Promise<AdminListQuestionRevisionsResponse> {
    let parsed: ReturnType<typeof AdminListQuestionRevisionsQuerySchema.parse>;
    try {
      parsed = AdminListQuestionRevisionsQuerySchema.parse(query);
    } catch {
      throw invalidRequest();
    }
    return this.get(
      "/v1/admin/content/question-revisions",
      parsed,
      AdminListQuestionRevisionsResponseSchema,
    );
  }

  async createQuestionRevision(
    input: AdminCreateQuestionRevisionRequest,
  ): Promise<AdminCreateQuestionRevisionResponse> {
    let parsed: AdminCreateQuestionRevisionRequest;
    try {
      parsed = AdminCreateQuestionRevisionRequestSchema.parse(input);
    } catch {
      throw invalidRequest();
    }
    return this.request(
      "/v1/admin/content/question-revisions",
      AdminCreateQuestionRevisionResponseSchema,
      { method: "POST", body: JSON.stringify(parsed) },
    );
  }

  async updateQuestionRevisionStatus(
    revisionId: string,
    input: AdminUpdateQuestionRevisionStatusRequest,
  ): Promise<AdminUpdateQuestionRevisionStatusResponse> {
    let id: string;
    let parsed: AdminUpdateQuestionRevisionStatusRequest;
    try {
      id = UuidSchema.parse(revisionId);
      parsed = AdminUpdateQuestionRevisionStatusRequestSchema.parse(input);
    } catch {
      throw invalidRequest();
    }
    return this.request(
      `/v1/admin/content/question-revisions/${encodeURIComponent(id)}/status`,
      AdminUpdateQuestionRevisionStatusResponseSchema,
      { method: "PATCH", body: JSON.stringify(parsed) },
    );
  }

  async listDailySets(
    query: AdminListDailySetsQuery,
  ): Promise<AdminListDailySetsResponse> {
    let parsed: AdminListDailySetsQuery;
    try {
      parsed = AdminListDailySetsQuerySchema.parse(query);
    } catch {
      throw invalidRequest();
    }
    return this.get(
      "/v1/admin/content/daily-sets",
      parsed,
      AdminListDailySetsResponseSchema,
    );
  }

  async createDailySetDraft(
    input: AdminCreateDailySetDraftRequest,
  ): Promise<AdminCreateDailySetDraftResponse> {
    let parsed: AdminCreateDailySetDraftRequest;
    try {
      parsed = AdminCreateDailySetDraftRequestSchema.parse(input);
    } catch {
      throw invalidRequest();
    }
    return this.request(
      "/v1/admin/content/daily-sets",
      AdminCreateDailySetDraftResponseSchema,
      { method: "POST", body: JSON.stringify(parsed) },
    );
  }

  async publishDailySet(
    dailySetId: string,
  ): Promise<AdminPublishDailySetResponse> {
    let id: string;
    try {
      id = UuidSchema.parse(dailySetId);
    } catch {
      throw invalidRequest();
    }
    return this.request(
      `/v1/admin/content/daily-sets/${encodeURIComponent(id)}/publish`,
      AdminPublishDailySetResponseSchema,
      { method: "POST" },
    );
  }

  async voidDailySet(
    dailySetId: string,
    input: AdminVoidDailySetRequest,
  ): Promise<AdminVoidDailySetResponse> {
    let id: string;
    let parsed: AdminVoidDailySetRequest;
    try {
      id = UuidSchema.parse(dailySetId);
      parsed = AdminVoidDailySetRequestSchema.parse(input);
    } catch {
      throw invalidRequest();
    }
    return this.request(
      `/v1/admin/content/daily-sets/${encodeURIComponent(id)}/void`,
      AdminVoidDailySetResponseSchema,
      { method: "PUT", body: JSON.stringify(parsed) },
    );
  }

  async listAuditLogs(
    query: AuditLogQuery = {},
  ): Promise<AdminListAuditLogsResponse> {
    let parsed: ReturnType<typeof AdminListAuditLogsQuerySchema.parse>;
    try {
      parsed = AdminListAuditLogsQuerySchema.parse(query);
    } catch {
      throw invalidRequest();
    }
    return this.get(
      "/v1/admin/content/audit-logs",
      parsed,
      AdminListAuditLogsResponseSchema,
    );
  }

  private async get<T>(
    path: string,
    query: object,
    parser: Parser<T>,
  ): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        search.set(key, String(value));
      }
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(`${path}${suffix}`, parser, { method: "GET" });
  }

  private async request<T>(
    path: string,
    parser: Parser<T>,
    init: RequestInit,
  ): Promise<T> {
    if (this.disposed || !this.token) {
      throw new ApiClientError({
        code: "ADMIN_SESSION_CLOSED",
        message: "운영자 세션이 종료되었습니다.",
      });
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    this.controllers.add(controller);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json; charset=utf-8" }),
        },
      });
    } catch (error) {
      const aborted =
        error instanceof DOMException && error.name === "AbortError";
      throw new ApiClientError({
        code: aborted ? "REQUEST_ABORTED" : "NETWORK_ERROR",
        message: aborted
          ? "요청 시간이 초과되었거나 요청이 취소되었습니다."
          : "네트워크 연결을 확인하고 다시 시도해 주세요.",
        retryable: true,
      });
    } finally {
      window.clearTimeout(timeout);
      this.controllers.delete(controller);
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
      const result = ApiErrorSchema.safeParse(payload);
      throw new ApiClientError({
        code: result.success ? result.data.code : "REQUEST_FAILED",
        message: result.success
          ? result.data.message
          : "요청을 처리하지 못했습니다.",
        requestId: result.success ? result.data.requestId : undefined,
        retryable: result.success
          ? result.data.retryable
          : response.status >= 500,
        status: response.status,
      });
    }

    try {
      return parser.parse(payload);
    } catch {
      throw new ApiClientError({
        code: "INVALID_RESPONSE",
        message: "서버 응답 형식이 올바르지 않습니다.",
        status: response.status,
      });
    }
  }
}
