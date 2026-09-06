import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import type { ReportReason } from "@daily-quiz-battle/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";
import {
  DEVELOPMENT_METRICS_ACCESS_TOKEN,
  type AppEnvironment,
} from "../config.js";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";
import { readPem } from "../shared/mtls-request.js";

const HTTP_LABEL_NAMES = ["method", "route", "status_class"] as const;
const OPERATION_TASK_LABEL_NAMES = ["task"] as const;
const IDENTITY_LABEL_NAMES = ["outcome"] as const;
const QUESTION_REPORT_LABEL_NAMES = ["reason", "result"] as const;
const OPERATIONAL_BLOCK_LABEL_NAMES = ["reason"] as const;
const EXCLUDED_ROUTES = new Set([
  "/health/live",
  "/health/ready",
  "/internal/metrics",
]);
const KNOWN_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

interface NotificationOutboxMetricsRow {
  pending_count: number;
  oldest_pending_age_seconds: number;
  failed_count: number;
}

type OperationTaskName = "cleanup" | "notification_worker";

interface OperationTaskMetricsRow {
  task_name: OperationTaskName;
  last_success_age_seconds: number | null;
  consecutive_failures: number;
}

const IDENTITY_OUTCOME_LABELS = {
  valid: "valid",
  invalid: "invalid",
  dependency_error: "dependency_error",
  invalid_response: "invalid_response",
} as const;

const QUESTION_REPORT_REASON_LABELS = {
  incorrect_answer: "incorrect_answer",
  ambiguous: "ambiguous",
  outdated: "outdated",
  inappropriate: "inappropriate",
  other: "other",
} as const satisfies Record<ReportReason, ReportReason>;

const QUESTION_REPORT_RESULT_LABELS = {
  new: "new",
  deduplicated: "deduplicated",
} as const;

const OPERATIONAL_BLOCK_REASON_LABELS = {
  daily_set_not_ready: "daily_set_not_ready",
  feature_disabled: "feature_disabled",
} as const;

type IdentityOutcome = keyof typeof IDENTITY_OUTCOME_LABELS;
type QuestionReportResult = keyof typeof QUESTION_REPORT_RESULT_LABELS;
type OperationalBlockReason = keyof typeof OPERATIONAL_BLOCK_REASON_LABELS;

function boundedLabel<T extends string>(
  allowlist: Partial<Record<T, T>>,
  value: T,
): T {
  if (!Object.prototype.hasOwnProperty.call(allowlist, value)) {
    throw new Error("Unsupported observability metric label");
  }
  return allowlist[value]!;
}

interface RequestMetricOutcome {
  identity?: IdentityOutcome;
  operationalBlock?: OperationalBlockReason;
}

export interface ObservabilityRecorder {
  recordIdentityOutcome(outcome: IdentityOutcome): void;
  recordQuestionReport(
    reason: ReportReason,
    result: QuestionReportResult,
  ): void;
  recordOperationalBlock(reason: OperationalBlockReason): void;
}

export interface ObservabilityMetricsOptions {
  appEnvironment: AppEnvironment;
  database: Database;
  metricsAccessToken: string;
  identityMtlsCert?: string;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hasValidAuthorization(
  request: FastifyRequest,
  expectedTokenDigest: Buffer,
): boolean {
  const authorization = request.headers.authorization;
  const match =
    authorization === undefined
      ? null
      : /^Bearer ([^\s]+)$/.exec(authorization);
  const candidateDigest = digest(match?.[1] ?? "");

  return (
    match !== null && timingSafeEqual(candidateDigest, expectedTokenDigest)
  );
}

function normalizedMethod(method: string): string {
  return KNOWN_METHODS.has(method) ? method : "OTHER";
}

function normalizedRoute(request: FastifyRequest): string {
  // Only Fastify's registered route template is used. The raw URL is never a
  // fallback because it can contain tokens, UUIDs, and other unbounded values.
  return request.routeOptions.url ?? "unmatched";
}

function statusClass(statusCode: number): string {
  if (statusCode < 100 || statusCode > 599) {
    return "other";
  }
  return `${Math.floor(statusCode / 100)}xx`;
}

function validateMetricsAccessToken(
  appEnvironment: AppEnvironment,
  metricsAccessToken: string,
): void {
  if (
    metricsAccessToken.length < 32 ||
    metricsAccessToken.trim() !== metricsAccessToken
  ) {
    throw new Error("METRICS_ACCESS_TOKEN must be at least 32 characters");
  }

  if (
    appEnvironment !== "development" &&
    metricsAccessToken === DEVELOPMENT_METRICS_ACCESS_TOKEN
  ) {
    throw new Error(
      "Non-development METRICS_ACCESS_TOKEN must not use the local default",
    );
  }
}

function requestMetricOutcome(
  error: unknown,
): RequestMetricOutcome | undefined {
  if (!(error instanceof AppError)) {
    return undefined;
  }

  switch (error.code) {
    case "INVALID_USER_KEY":
      return { identity: "invalid" };
    case "IDENTITY_DEPENDENCY_UNAVAILABLE":
      return { identity: "dependency_error" };
    case "IDENTITY_INVALID_RESPONSE":
      return { identity: "invalid_response" };
    case "DAILY_SET_NOT_READY":
      return { operationalBlock: "daily_set_not_ready" };
    case "FEATURE_DISABLED":
      return { operationalBlock: "feature_disabled" };
    default:
      return undefined;
  }
}

export function registerObservabilityMetrics(
  app: FastifyInstance,
  options: ObservabilityMetricsOptions,
): ObservabilityRecorder {
  validateMetricsAccessToken(
    options.appEnvironment,
    options.metricsAccessToken,
  );

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requestTotal = new Counter({
    name: "daily_quiz_api_http_requests_total",
    help: "Completed API requests by bounded route, method, and status class.",
    labelNames: HTTP_LABEL_NAMES,
    registers: [registry],
  });
  const requestDuration = new Histogram({
    name: "daily_quiz_api_http_request_duration_seconds",
    help: "API request latency in seconds by bounded route, method, and status class.",
    labelNames: HTTP_LABEL_NAMES,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const outboxPending = new Gauge({
    name: "daily_quiz_api_notification_outbox_pending",
    help: "Current number of pending notification outbox rows.",
    registers: [registry],
  });
  const outboxOldestPendingAge = new Gauge({
    name: "daily_quiz_api_notification_outbox_oldest_pending_age_seconds",
    help: "Age in seconds of the oldest pending notification outbox row.",
    registers: [registry],
  });
  const outboxFailed = new Gauge({
    name: "daily_quiz_api_notification_outbox_failed",
    help: "Current number of failed notification outbox rows.",
    registers: [registry],
  });
  const operationTaskLastSuccessAge = new Gauge({
    name: "daily_quiz_api_operation_task_last_success_age_seconds",
    help: "Age in seconds of the last successful operation task run.",
    labelNames: OPERATION_TASK_LABEL_NAMES,
    registers: [registry],
  });
  const operationTaskConsecutiveFailures = new Gauge({
    name: "daily_quiz_api_operation_task_consecutive_failures",
    help: "Current consecutive failure count for an operation task.",
    labelNames: OPERATION_TASK_LABEL_NAMES,
    registers: [registry],
  });
  const identityVerificationTotal = new Counter({
    name: "daily_quiz_api_identity_verification_total",
    help: "Identity verification outcomes.",
    labelNames: IDENTITY_LABEL_NAMES,
    registers: [registry],
  });
  const questionReportTotal = new Counter({
    name: "daily_quiz_api_question_reports_total",
    help: "Question report submissions by bounded reason and result.",
    labelNames: QUESTION_REPORT_LABEL_NAMES,
    registers: [registry],
  });
  const operationalBlockTotal = new Counter({
    name: "daily_quiz_api_operational_blocks_total",
    help: "Requests blocked by bounded operational conditions.",
    labelNames: OPERATIONAL_BLOCK_LABEL_NAMES,
    registers: [registry],
  });
  for (const outcome of Object.values(IDENTITY_OUTCOME_LABELS)) {
    identityVerificationTotal.inc({ outcome }, 0);
  }
  for (const reason of Object.values(QUESTION_REPORT_REASON_LABELS)) {
    for (const result of Object.values(QUESTION_REPORT_RESULT_LABELS)) {
      questionReportTotal.inc({ reason, result }, 0);
    }
  }
  for (const reason of Object.values(OPERATIONAL_BLOCK_REASON_LABELS)) {
    operationalBlockTotal.inc({ reason }, 0);
  }

  if (options.identityMtlsCert) {
    const certificate = new X509Certificate(readPem(options.identityMtlsCert));
    const expiryTimestamp = new Date(certificate.validTo).getTime() / 1_000;
    if (!Number.isFinite(expiryTimestamp)) {
      throw new Error("Identity mTLS certificate has an invalid expiry");
    }

    const identityCertificateExpiry = new Gauge({
      name: "daily_quiz_api_identity_mtls_certificate_expiry_timestamp_seconds",
      help: "Identity mTLS client certificate expiry as a Unix timestamp.",
      registers: [registry],
    });
    identityCertificateExpiry.set(expiryTimestamp);
  }

  const recorder: ObservabilityRecorder = {
    recordIdentityOutcome(outcome) {
      identityVerificationTotal.inc({
        outcome: boundedLabel(IDENTITY_OUTCOME_LABELS, outcome),
      });
    },
    recordQuestionReport(reason, result) {
      questionReportTotal.inc({
        reason: boundedLabel(QUESTION_REPORT_REASON_LABELS, reason),
        result: boundedLabel(QUESTION_REPORT_RESULT_LABELS, result),
      });
    },
    recordOperationalBlock(reason) {
      operationalBlockTotal.inc({
        reason: boundedLabel(OPERATIONAL_BLOCK_REASON_LABELS, reason),
      });
    },
  };
  const expectedTokenDigest = digest(options.metricsAccessToken);
  const requestOutcomes = new WeakMap<FastifyRequest, RequestMetricOutcome>();

  app.addHook("onError", async (request, _reply, error) => {
    if (EXCLUDED_ROUTES.has(normalizedRoute(request))) {
      return;
    }

    const outcome = requestMetricOutcome(error);
    if (outcome !== undefined) {
      requestOutcomes.set(request, outcome);
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = normalizedRoute(request);
    if (EXCLUDED_ROUTES.has(route)) {
      return;
    }

    const outcome = requestOutcomes.get(request);
    if (outcome?.identity !== undefined) {
      recorder.recordIdentityOutcome(outcome.identity);
    } else if (
      route === "/v1/auth/bootstrap" &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300
    ) {
      recorder.recordIdentityOutcome("valid");
    }
    if (outcome?.operationalBlock !== undefined) {
      recorder.recordOperationalBlock(outcome.operationalBlock);
    }

    const labels = {
      method: normalizedMethod(request.method),
      route,
      status_class: statusClass(reply.statusCode),
    };
    requestTotal.inc(labels);
    requestDuration.observe(labels, reply.elapsedTime / 1_000);
  });

  app.get("/internal/metrics", async (request, reply) => {
    if (!hasValidAuthorization(request, expectedTokenDigest)) {
      throw new AppError({
        statusCode: 401,
        code: "METRICS_UNAUTHORIZED",
        message: "메트릭 인증이 필요합니다.",
      });
    }

    let rows: NotificationOutboxMetricsRow[];
    let operationRows: OperationTaskMetricsRow[];
    try {
      rows = await options.database.client<NotificationOutboxMetricsRow[]>`
        SELECT
          (count(*) FILTER (WHERE status = 'pending'))::int AS pending_count,
          greatest(
            0,
            coalesce(
              extract(
                epoch FROM (
                  current_timestamp
                  - (
                    min(occurred_at) FILTER (WHERE status = 'pending')
                  )
                )
              ),
              0
            )
          )::double precision AS oldest_pending_age_seconds,
          (count(*) FILTER (WHERE status = 'failed'))::int AS failed_count
        FROM notification_outbox
      `;
      operationRows = await options.database.client<OperationTaskMetricsRow[]>`
          WITH allowed_tasks(task_name) AS (
            VALUES
              ('cleanup'::text),
              ('notification_worker'::text)
          )
          SELECT
            allowed_tasks.task_name,
            CASE
              WHEN operation_task_runs.last_succeeded_at IS NULL THEN NULL
              ELSE greatest(
                0,
                extract(
                  epoch FROM (
                    current_timestamp
                    - operation_task_runs.last_succeeded_at
                  )
                )
              )::double precision
            END AS last_success_age_seconds,
            coalesce(
              operation_task_runs.consecutive_failures,
              0
            )::int AS consecutive_failures
          FROM allowed_tasks
          LEFT JOIN operation_task_runs
            ON operation_task_runs.task_name = allowed_tasks.task_name
        `;
    } catch (error) {
      request.log.error({ err: error }, "metrics aggregate query failed");
      throw new AppError({
        statusCode: 503,
        code: "METRICS_UNAVAILABLE",
        message: "메트릭을 조회할 수 없습니다.",
        retryable: true,
      });
    }

    const aggregate = rows[0];
    if (aggregate === undefined) {
      throw new AppError({
        statusCode: 503,
        code: "METRICS_UNAVAILABLE",
        message: "메트릭을 조회할 수 없습니다.",
        retryable: true,
      });
    }

    outboxPending.set(aggregate.pending_count);
    outboxOldestPendingAge.set(aggregate.oldest_pending_age_seconds);
    outboxFailed.set(aggregate.failed_count);
    operationTaskLastSuccessAge.reset();
    operationTaskConsecutiveFailures.reset();
    for (const operationRow of operationRows) {
      const labels = { task: operationRow.task_name };
      if (operationRow.last_success_age_seconds !== null) {
        operationTaskLastSuccessAge.set(
          labels,
          operationRow.last_success_age_seconds,
        );
      }
      operationTaskConsecutiveFailures.set(
        labels,
        operationRow.consecutive_failures,
      );
    }

    reply.header("cache-control", "no-store");
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  return recorder;
}
