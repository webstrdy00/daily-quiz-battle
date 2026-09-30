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
  AdminListReportsQuerySchema,
  AdminListReportsResponseSchema,
  AdminPublishDailySetResponseSchema,
  AdminUpdateQuestionRevisionStatusRequestSchema,
  AdminUpdateQuestionRevisionStatusResponseSchema,
  AdminUpdateReportStatusRequestSchema,
  AdminUpdateReportStatusResponseSchema,
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
  type AdminListReportsResponse,
  type AdminPublishDailySetResponse,
  type AdminUpdateQuestionRevisionStatusRequest,
  type AdminUpdateQuestionRevisionStatusResponse,
  type AdminUpdateReportStatusRequest,
  type AdminUpdateReportStatusResponse,
  type AdminVoidDailySetRequest,
  type AdminVoidDailySetResponse,
  type ContentStatus,
  type ReportReason,
  type ReportStatus,
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

export interface ReportQuery {
  cursor?: AdminContentCursor;
  limit?: number;
  status?: ReportStatus;
  reasonCode?: ReportReason;
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

// Unverified JWT claims only bound local UI lifetime. The API still authenticates
// every request, including signature, issuer, audience, role and expiry checks.
export function tokenExpiryHint(token: string, now = Date.now()): number {
  try {
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts.some(
        (part) => !/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1,
      )
    ) {
      throw new Error("Invalid JWT encoding");
    }
    const decode = (part: string): unknown => {
      const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
        (character) => character.charCodeAt(0),
      );
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    };
    const header = decode(parts[0]) as { alg?: unknown } | null;
    const payload = decode(parts[1]) as { exp?: unknown } | null;
    if (
      !header ||
      typeof header.alg !== "string" ||
      !header.alg ||
      !payload ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      !Number.isSafeInteger(payload.exp * 1000)
    ) {
      throw new Error("Invalid JWT expiry");
    }
    const expiresAt = payload.exp * 1000;
    if (expiresAt <= now) {
      throw new Error("Expired JWT");
    }
    return expiresAt;
  } catch {
    throw new ApiClientError({
      code: "ADMIN_TOKEN_INVALID",
      message:
        "운영자 JWT가 만료되었거나 형식이 올바르지 않습니다. 새 토큰을 입력해 주세요.",
    });
  }
}

export class AdminApiClient {
  private token: string;
  private readonly baseUrl: string;
  private readonly expiresAt: number;
  private readonly onExpire: () => void;
  private expiryTimer: number | undefined;
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  constructor(token: string, onExpire: () => void) {
    if (!token.trim()) {
      throw new ApiClientError({
        code: "ADMIN_TOKEN_REQUIRED",
        message: "15분 운영자 JWT를 입력해 주세요.",
      });
    }
    this.expiresAt = tokenExpiryHint(token.trim());
    this.onExpire = onExpire;
    this.token = token.trim();
    this.baseUrl = resolveApiBaseUrl();
    this.scheduleExpiry();
    window.addEventListener("focus", this.checkExpiry);
    document.addEventListener("visibilitychange", this.checkExpiry);
    window.addEventListener("pageshow", this.checkExpiry);
  }

  private readonly checkExpiry = (): void => {
    if (!this.disposed && Date.now() >= this.expiresAt) {
      this.dispose();
      this.onExpire();
    }
  };

  private scheduleExpiry(): void {
    this.expiryTimer = window.setTimeout(
      () => {
        this.checkExpiry();
        if (!this.disposed) this.scheduleExpiry();
      },
      Math.min(Math.max(0, this.expiresAt - Date.now()), 2_147_483_647),
    );
  }

  private assertActive(): void {
    this.checkExpiry();
    if (this.disposed || !this.token) {
      throw new ApiClientError({
        code: "ADMIN_SESSION_CLOSED",
        message: "운영자 세션이 종료되었습니다.",
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.token = "";
    window.clearTimeout(this.expiryTimer);
    window.removeEventListener("focus", this.checkExpiry);
    document.removeEventListener("visibilitychange", this.checkExpiry);
    window.removeEventListener("pageshow", this.checkExpiry);
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

  async listReports(
    query: ReportQuery = {},
  ): Promise<AdminListReportsResponse> {
    let parsed: ReturnType<typeof AdminListReportsQuerySchema.parse>;
    try {
      parsed = AdminListReportsQuerySchema.parse(query);
    } catch {
      throw invalidRequest();
    }
    return this.get(
      "/v1/admin/reports",
      parsed,
      AdminListReportsResponseSchema,
    );
  }

  async updateReportStatus(
    reportId: string,
    input: AdminUpdateReportStatusRequest,
  ): Promise<AdminUpdateReportStatusResponse> {
    let id: string;
    let parsed: AdminUpdateReportStatusRequest;
    try {
      id = UuidSchema.parse(reportId);
      parsed = AdminUpdateReportStatusRequestSchema.parse(input);
    } catch {
      throw invalidRequest();
    }
    return this.request(
      `/v1/admin/reports/${encodeURIComponent(id)}/status`,
      AdminUpdateReportStatusResponseSchema,
      { method: "PATCH", body: JSON.stringify(parsed) },
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
    this.assertActive();

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
      window.clearTimeout(timeout);
      this.controllers.delete(controller);
      const aborted =
        error instanceof DOMException && error.name === "AbortError";
      throw new ApiClientError({
        code: aborted ? "REQUEST_ABORTED" : "NETWORK_ERROR",
        message: aborted
          ? "요청 시간이 초과되었거나 요청이 취소되었습니다."
          : "네트워크 연결을 확인하고 다시 시도해 주세요.",
        retryable: true,
      });
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
    } finally {
      window.clearTimeout(timeout);
      this.controllers.delete(controller);
    }

    this.assertActive();
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
