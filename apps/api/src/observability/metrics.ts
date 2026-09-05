import { createHash, timingSafeEqual } from "node:crypto";
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

const HTTP_LABEL_NAMES = ["method", "route", "status_class"] as const;
const OPERATION_TASK_LABEL_NAMES = ["task"] as const;
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

export interface ObservabilityMetricsOptions {
  appEnvironment: AppEnvironment;
  database: Database;
  metricsAccessToken: string;
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

export function registerObservabilityMetrics(
  app: FastifyInstance,
  options: ObservabilityMetricsOptions,
): void {
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
  const expectedTokenDigest = digest(options.metricsAccessToken);

  app.addHook("onResponse", async (request, reply) => {
    const route = normalizedRoute(request);
    if (EXCLUDED_ROUTES.has(route)) {
      return;
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
}
