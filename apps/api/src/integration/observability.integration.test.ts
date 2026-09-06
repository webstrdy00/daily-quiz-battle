import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { buildApp } from "../app.js";
import { DEVELOPMENT_METRICS_ACCESS_TOKEN } from "../config.js";
import type { Database } from "../db/client.js";
import { registerObservabilityMetrics } from "../observability/metrics.js";
import { AppError } from "../shared/errors.js";
import {
  PRIMARY_DAY_NOON,
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

const RAW_ANONYMOUS_KEY = "dev-metrics-raw-anon-key-sensitive-value";
const RAW_INVALID_ANONYMOUS_KEY =
  "metrics-invalid-anonymous-key-sensitive-value";
const RAW_APPLICATION_TOKEN = "metrics-raw-bearer-token-sensitive-value";
const RAW_REPORT_DETAIL = "metrics-report-detail-sensitive-value";
const RAW_DUPLICATE_REPORT_DETAIL = "duplicate-metrics-report-sensitive-value";
const PATH_UUID = randomUUID();
const CUSTOM_METRIC_FAMILIES = [
  "daily_quiz_api_http_request_duration_seconds",
  "daily_quiz_api_http_requests_total",
  "daily_quiz_api_identity_verification_total",
  "daily_quiz_api_notification_outbox_failed",
  "daily_quiz_api_notification_outbox_oldest_pending_age_seconds",
  "daily_quiz_api_notification_outbox_pending",
  "daily_quiz_api_operation_task_consecutive_failures",
  "daily_quiz_api_operation_task_last_success_age_seconds",
  "daily_quiz_api_operational_blocks_total",
  "daily_quiz_api_question_reports_total",
] as const;

let harness: IntegrationHarness;

before(async () => {
  harness = await createIntegrationHarness();
});

after(async () => {
  await harness?.close();
});

function metricsAuthorization(): Record<string, string> {
  return {
    authorization: `Bearer ${DEVELOPMENT_METRICS_ACCESS_TOKEN}`,
  };
}

function metricValue(body: string, metricName: string): number {
  const prefix = `${metricName} `;
  const line = body
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `missing metric sample: ${metricName}`);
  const value = Number(line.slice(prefix.length));
  assert.equal(Number.isFinite(value), true, line);
  return value;
}

function labeledMetricValue(
  body: string,
  metricName: string,
  labels: Record<string, string>,
): number {
  const serializedLabels = Object.entries(labels)
    .map(([name, value]) => `${name}="${value}"`)
    .join(",");
  return metricValue(body, `${metricName}{${serializedLabels}}`);
}

async function scrapeMetrics(app = harness.app): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url: "/internal/metrics",
    headers: metricsAuthorization(),
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.body;
}

async function insertOutboxBacklog(): Promise<void> {
  const userId = randomUUID();
  const challengeId = randomUUID();

  await harness.database.client`
    INSERT INTO users (id, anon_key_fingerprint, identity_verified_at)
    VALUES (${userId}, ${randomUUID().replaceAll("-", "")}, current_timestamp)
  `;
  await harness.database.client`
    INSERT INTO operation_task_runs (
      task_name,
      last_started_at,
      last_succeeded_at,
      consecutive_failures,
      last_duration_ms
    )
    VALUES (
      'cleanup',
      current_timestamp - interval '2 minutes',
      current_timestamp - interval '2 minutes',
      0,
      25
    )
  `;
  await harness.database.client`
    INSERT INTO challenges (
      id,
      public_token_hash,
      daily_set_id,
      creator_user_id,
      expires_at,
      result_redacted_at
    )
    VALUES (
      ${challengeId},
      ${`metrics-fixture-${challengeId}`},
      (SELECT id FROM daily_sets WHERE status = 'published' ORDER BY quiz_date LIMIT 1),
      ${userId},
      current_timestamp + interval '1 day',
      current_timestamp
    )
  `;
  await harness.database.client`
    INSERT INTO notification_outbox (
      event_type,
      recipient_user_id,
      challenge_id,
      dedupe_key,
      status,
      available_at,
      occurred_at,
      last_error
    )
    VALUES
      (
        'challenge.completed',
        ${userId},
        ${challengeId},
        ${`metrics-pending-oldest-${challengeId}`},
        'pending',
        current_timestamp - interval '90 seconds',
        current_timestamp - interval '90 seconds',
        NULL
      ),
      (
        'challenge.completed',
        ${userId},
        ${challengeId},
        ${`metrics-pending-newer-${challengeId}`},
        'pending',
        current_timestamp - interval '15 seconds',
        current_timestamp - interval '15 seconds',
        NULL
      ),
      (
        'challenge.completed',
        ${userId},
        ${challengeId},
        ${`metrics-failed-${challengeId}`},
        'failed',
        current_timestamp - interval '5 minutes',
        current_timestamp - interval '5 minutes',
        'delivery_failed'
      )
  `;
}

test("metrics endpoint rejects missing and incorrect bearer credentials", async () => {
  const missing = await harness.app.inject({
    method: "GET",
    url: "/internal/metrics",
  });
  assert.equal(missing.statusCode, 401, missing.body);
  assert.equal(missing.json().code, "METRICS_UNAUTHORIZED");

  const incorrect = await harness.app.inject({
    method: "GET",
    url: "/internal/metrics",
    headers: { authorization: `Bearer ${RAW_APPLICATION_TOKEN}` },
  });
  assert.equal(incorrect.statusCode, 401, incorrect.body);
  assert.equal(incorrect.json().code, "METRICS_UNAUTHORIZED");
});

test("Prometheus scrape exposes bounded HTTP and outbox aggregates without sensitive values", async () => {
  await insertOutboxBacklog();

  const bootstrap = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey: RAW_ANONYMOUS_KEY },
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const issuedAccessToken = (bootstrap.json() as { accessToken: string })
    .accessToken;
  assert.ok(issuedAccessToken);

  const invalidBootstrap = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey: RAW_INVALID_ANONYMOUS_KEY },
  });
  assert.equal(invalidBootstrap.statusCode, 401, invalidBootstrap.body);
  assert.equal(invalidBootstrap.json().code, "INVALID_USER_KEY");

  const dailyStart = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: { authorization: `Bearer ${issuedAccessToken}` },
    payload: {},
  });
  assert.equal(dailyStart.statusCode, 200, dailyStart.body);
  const dailyStartBody = dailyStart.json() as {
    status: string;
    questions: { revisionId: string }[];
  };
  assert.equal(dailyStartBody.status, "available");
  const questionRevisionId = dailyStartBody.questions[0]?.revisionId;
  assert.ok(questionRevisionId);

  const firstReport = await harness.app.inject({
    method: "POST",
    url: "/v1/reports/questions",
    headers: { authorization: `Bearer ${issuedAccessToken}` },
    payload: {
      questionRevisionId,
      reasonCode: "other",
      detail: RAW_REPORT_DETAIL,
    },
  });
  assert.equal(firstReport.statusCode, 200, firstReport.body);
  const firstReportBody = firstReport.json() as {
    id: string;
    deduplicated: boolean;
  };
  assert.equal(firstReportBody.deduplicated, false);

  const duplicateReport = await harness.app.inject({
    method: "POST",
    url: "/v1/reports/questions",
    headers: { authorization: `Bearer ${issuedAccessToken}` },
    payload: {
      questionRevisionId,
      reasonCode: "other",
      detail: RAW_DUPLICATE_REPORT_DETAIL,
    },
  });
  assert.equal(duplicateReport.statusCode, 200, duplicateReport.body);
  assert.equal(
    (duplicateReport.json() as { deduplicated: boolean }).deduplicated,
    true,
  );

  const reportRows = await harness.database.client<
    { reporter_user_id: string }[]
  >`
    SELECT reporter_user_id
    FROM reports
    WHERE id = ${firstReportBody.id}
  `;
  const reporterUserId = reportRows[0]?.reporter_user_id;
  assert.ok(reporterUserId);

  const dynamicPath = await harness.app.inject({
    method: "GET",
    url: `/v1/challenges/${PATH_UUID}`,
    headers: { authorization: `Bearer ${RAW_APPLICATION_TOKEN}` },
  });
  assert.equal(dynamicPath.statusCode, 401, dynamicPath.body);

  const health = await harness.app.inject({
    method: "GET",
    url: "/health/live",
  });
  assert.equal(health.statusCode, 200, health.body);

  const firstScrape = await harness.app.inject({
    method: "GET",
    url: "/internal/metrics",
    headers: metricsAuthorization(),
  });
  assert.equal(firstScrape.statusCode, 200, firstScrape.body);

  // A second scrape proves that the first metrics request was not recorded.
  const scrape = await harness.app.inject({
    method: "GET",
    url: "/internal/metrics",
    headers: metricsAuthorization(),
  });
  assert.equal(scrape.statusCode, 200, scrape.body);
  assert.match(scrape.headers["content-type"] ?? "", /^text\/plain\b/);
  assert.equal(scrape.headers["cache-control"], "no-store");

  const body = scrape.body;
  assert.match(body, /^# HELP process_cpu_user_seconds_total /m);
  assert.deepEqual(
    [...body.matchAll(/^# HELP (daily_quiz_api_[a-z0-9_]+) /gm)]
      .map((match) => match[1])
      .sort(),
    [...CUSTOM_METRIC_FAMILIES].sort(),
  );
  assert.match(
    body,
    /daily_quiz_api_http_requests_total\{method="POST",route="\/v1\/auth\/bootstrap",status_class="2xx"\} 1/,
  );
  assert.match(
    body,
    /daily_quiz_api_http_requests_total\{method="GET",route="\/v1\/challenges\/:token",status_class="4xx"\} 1/,
  );
  assert.match(
    body,
    /daily_quiz_api_http_request_duration_seconds_count\{method="POST",route="\/v1\/auth\/bootstrap",status_class="2xx"\} 1/,
  );
  assert.equal(
    labeledMetricValue(body, "daily_quiz_api_identity_verification_total", {
      outcome: "valid",
    }),
    1,
  );
  assert.equal(
    labeledMetricValue(body, "daily_quiz_api_identity_verification_total", {
      outcome: "invalid",
    }),
    1,
  );
  assert.equal(
    labeledMetricValue(body, "daily_quiz_api_question_reports_total", {
      reason: "other",
      result: "new",
    }),
    1,
  );
  assert.equal(
    labeledMetricValue(body, "daily_quiz_api_question_reports_total", {
      reason: "other",
      result: "deduplicated",
    }),
    1,
  );
  assert.equal(body.includes('route="/health/live"'), false);
  assert.equal(body.includes('route="/internal/metrics"'), false);
  assert.equal(
    body.includes(
      "daily_quiz_api_identity_mtls_certificate_expiry_timestamp_seconds",
    ),
    false,
  );

  const allowedHttpLabelNames = new Set([
    "le",
    "method",
    "route",
    "status_class",
  ]);
  const customHttpSamples = body
    .split("\n")
    .filter(
      (line) => line.startsWith("daily_quiz_api_http_") && line.includes("{"),
    );
  assert.ok(customHttpSamples.length > 0);
  for (const sample of customHttpSamples) {
    const labels = sample.slice(sample.indexOf("{") + 1, sample.indexOf("}"));
    for (const label of labels.split(",")) {
      const labelName = label.slice(0, label.indexOf("="));
      assert.equal(
        allowedHttpLabelNames.has(labelName),
        true,
        `unexpected HTTP metric label ${labelName}`,
      );
    }
  }

  const allowedIdentityLabelNames = new Set(["outcome"]);
  const allowedIdentityOutcomes = new Set([
    "valid",
    "invalid",
    "dependency_error",
    "invalid_response",
  ]);
  const identitySamples = body
    .split("\n")
    .filter((line) =>
      line.startsWith("daily_quiz_api_identity_verification_total{"),
    );
  assert.ok(identitySamples.length > 0);
  for (const sample of identitySamples) {
    const labels = sample.slice(sample.indexOf("{") + 1, sample.indexOf("}"));
    for (const label of labels.split(",")) {
      const labelName = label.slice(0, label.indexOf("="));
      assert.equal(
        allowedIdentityLabelNames.has(labelName),
        true,
        `unexpected identity metric label ${labelName}`,
      );
      const labelValue = label.slice(label.indexOf("=") + 2, -1);
      assert.equal(
        allowedIdentityOutcomes.has(labelValue),
        true,
        `unexpected identity outcome ${labelValue}`,
      );
    }
  }

  const allowedReportLabelNames = new Set(["reason", "result"]);
  const allowedReportReasons = new Set([
    "incorrect_answer",
    "ambiguous",
    "outdated",
    "inappropriate",
    "other",
  ]);
  const allowedReportResults = new Set(["new", "deduplicated"]);
  const reportSamples = body
    .split("\n")
    .filter((line) =>
      line.startsWith("daily_quiz_api_question_reports_total{"),
    );
  assert.ok(reportSamples.length > 0);
  for (const sample of reportSamples) {
    const labels = sample.slice(sample.indexOf("{") + 1, sample.indexOf("}"));
    for (const label of labels.split(",")) {
      const labelName = label.slice(0, label.indexOf("="));
      assert.equal(
        allowedReportLabelNames.has(labelName),
        true,
        `unexpected report metric label ${labelName}`,
      );
      const labelValue = label.slice(label.indexOf("=") + 2, -1);
      const allowedValues =
        labelName === "reason" ? allowedReportReasons : allowedReportResults;
      assert.equal(
        allowedValues.has(labelValue),
        true,
        `unexpected report metric ${labelName} ${labelValue}`,
      );
    }
  }

  const operationalBlockSamples = body
    .split("\n")
    .filter((line) =>
      line.startsWith("daily_quiz_api_operational_blocks_total{"),
    );
  assert.ok(operationalBlockSamples.length > 0);
  const allowedOperationalBlockReasons = new Set([
    "daily_set_not_ready",
    "feature_disabled",
  ]);
  for (const sample of operationalBlockSamples) {
    const labels = sample.slice(sample.indexOf("{") + 1, sample.indexOf("}"));
    for (const label of labels.split(",")) {
      const labelName = label.slice(0, label.indexOf("="));
      assert.equal(labelName, "reason");
      const labelValue = label.slice(label.indexOf("=") + 2, -1);
      assert.equal(
        allowedOperationalBlockReasons.has(labelValue),
        true,
        `unexpected operational block reason ${labelValue}`,
      );
    }
  }

  assert.equal(
    metricValue(body, "daily_quiz_api_notification_outbox_pending"),
    2,
  );
  assert.equal(
    metricValue(body, "daily_quiz_api_notification_outbox_failed"),
    1,
  );
  assert.ok(
    metricValue(
      body,
      "daily_quiz_api_notification_outbox_oldest_pending_age_seconds",
    ) >= 89,
  );
  assert.match(body, /^daily_quiz_api_notification_outbox_pending 2$/m);
  assert.match(body, /^daily_quiz_api_notification_outbox_failed 1$/m);
  assert.match(
    body,
    /^daily_quiz_api_operation_task_last_success_age_seconds\{task="cleanup"\} 1[12][0-9](?:\.\d+)?$/m,
  );
  assert.match(
    body,
    /^daily_quiz_api_operation_task_consecutive_failures\{task="cleanup"\} 0$/m,
  );
  assert.match(
    body,
    /^daily_quiz_api_operation_task_consecutive_failures\{task="notification_worker"\} 0$/m,
  );

  for (const sensitiveValue of [
    DEVELOPMENT_METRICS_ACCESS_TOKEN,
    RAW_APPLICATION_TOKEN,
    RAW_ANONYMOUS_KEY,
    RAW_INVALID_ANONYMOUS_KEY,
    RAW_REPORT_DETAIL,
    RAW_DUPLICATE_REPORT_DETAIL,
    PATH_UUID,
    issuedAccessToken,
    questionRevisionId,
    firstReportBody.id,
    reporterUserId,
  ]) {
    assert.equal(body.includes(sensitiveValue), false, sensitiveValue);
  }
});

test("observability hooks record each bounded identity and operational outcome exactly once", async () => {
  const app = Fastify({ logger: false });
  const recorder = registerObservabilityMetrics(app, {
    appEnvironment: "development",
    database: harness.database,
    metricsAccessToken: DEVELOPMENT_METRICS_ACCESS_TOKEN,
  });
  const rejectedLabel = "raw-sensitive-label-value";

  assert.throws(
    () =>
      recorder.recordIdentityOutcome(
        rejectedLabel as Parameters<typeof recorder.recordIdentityOutcome>[0],
      ),
    /Unsupported observability metric label/,
  );
  assert.throws(
    () =>
      recorder.recordQuestionReport(
        rejectedLabel as Parameters<typeof recorder.recordQuestionReport>[0],
        "new",
      ),
    /Unsupported observability metric label/,
  );
  assert.throws(
    () =>
      recorder.recordQuestionReport(
        "other",
        rejectedLabel as Parameters<typeof recorder.recordQuestionReport>[1],
      ),
    /Unsupported observability metric label/,
  );
  assert.throws(
    () =>
      recorder.recordOperationalBlock(
        rejectedLabel as Parameters<typeof recorder.recordOperationalBlock>[0],
      ),
    /Unsupported observability metric label/,
  );

  app.post("/v1/auth/bootstrap", async (request) => {
    const outcome = request.headers["x-test-identity-outcome"];
    switch (outcome) {
      case "invalid":
        throw new AppError({
          statusCode: 401,
          code: "INVALID_USER_KEY",
          message: "invalid",
        });
      case "dependency_error":
        throw new AppError({
          statusCode: 503,
          code: "IDENTITY_DEPENDENCY_UNAVAILABLE",
          message: "unavailable",
        });
      case "invalid_response":
        throw new AppError({
          statusCode: 503,
          code: "IDENTITY_INVALID_RESPONSE",
          message: "invalid response",
        });
      default:
        return { status: "valid" };
    }
  });
  app.get("/probe/operational/:reason", async (request) => {
    const { reason } = request.params as { reason: string };
    throw new AppError({
      statusCode: 503,
      code:
        reason === "daily-set-not-ready"
          ? "DAILY_SET_NOT_READY"
          : "FEATURE_DISABLED",
      message: "blocked",
      retryable: true,
    });
  });
  app.get("/health/live", async () => {
    throw new AppError({
      statusCode: 503,
      code: "FEATURE_DISABLED",
      message: "excluded",
      retryable: true,
    });
  });

  try {
    const valid = await app.inject({
      method: "POST",
      url: "/v1/auth/bootstrap",
    });
    assert.equal(valid.statusCode, 200, valid.body);

    for (const [outcome, expectedStatus] of [
      ["invalid", 401],
      ["dependency_error", 503],
      ["invalid_response", 503],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/bootstrap",
        headers: { "x-test-identity-outcome": outcome },
      });
      assert.equal(response.statusCode, expectedStatus, response.body);
    }

    for (const reason of ["daily-set-not-ready", "feature-disabled"]) {
      const response = await app.inject({
        method: "GET",
        url: `/probe/operational/${reason}`,
      });
      assert.equal(response.statusCode, 503, response.body);
    }

    const excludedHealth = await app.inject({
      method: "GET",
      url: "/health/live",
    });
    assert.equal(excludedHealth.statusCode, 503, excludedHealth.body);

    const body = await scrapeMetrics(app);
    for (const outcome of [
      "valid",
      "invalid",
      "dependency_error",
      "invalid_response",
    ]) {
      assert.equal(
        labeledMetricValue(body, "daily_quiz_api_identity_verification_total", {
          outcome,
        }),
        1,
      );
    }
    assert.equal(
      labeledMetricValue(body, "daily_quiz_api_operational_blocks_total", {
        reason: "daily_set_not_ready",
      }),
      1,
    );
    assert.equal(
      labeledMetricValue(body, "daily_quiz_api_operational_blocks_total", {
        reason: "feature_disabled",
      }),
      1,
    );
    assert.equal(body.includes(rejectedLabel), false);
  } finally {
    await app.close();
  }
});

test("actual daily app paths record not-ready and feature-disabled blocks", async () => {
  const bootstrap = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey: "dev-metrics-operational-block-user" },
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const accessToken = (bootstrap.json() as { accessToken: string }).accessToken;

  harness.setNow("2126-08-29T03:00:00.000Z");
  try {
    const notReady = await harness.app.inject({
      method: "POST",
      url: "/v1/daily/start",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    assert.equal(notReady.statusCode, 503, notReady.body);
    assert.equal(notReady.json().code, "DAILY_SET_NOT_READY");
  } finally {
    harness.setNow(PRIMARY_DAY_NOON);
  }

  const notReadyMetrics = await scrapeMetrics();
  assert.equal(
    labeledMetricValue(
      notReadyMetrics,
      "daily_quiz_api_operational_blocks_total",
      { reason: "daily_set_not_ready" },
    ),
    1,
  );

  const borrowedDatabase: Database = {
    client: harness.database.client,
    orm: harness.database.orm,
    close: async () => undefined,
  };
  const disabledApp = await buildApp({
    config: {
      ...harness.config,
      dailyStartEnabled: false,
    },
    database: borrowedDatabase,
  });
  try {
    const disabled = await disabledApp.inject({
      method: "POST",
      url: "/v1/daily/start",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    assert.equal(disabled.statusCode, 503, disabled.body);
    assert.equal(disabled.json().code, "FEATURE_DISABLED");

    const disabledMetrics = await scrapeMetrics(disabledApp);
    assert.equal(
      labeledMetricValue(
        disabledMetrics,
        "daily_quiz_api_operational_blocks_total",
        { reason: "feature_disabled" },
      ),
      1,
    );
  } finally {
    await disabledApp.close();
  }
});

test("identity certificate expiry is absent when unconfigured and parsed at startup when configured", async () => {
  const certificatePem = rootCertificates[0];
  assert.ok(certificatePem);
  const certificate = new X509Certificate(certificatePem);
  const expectedExpiry = new Date(certificate.validTo).getTime() / 1_000;
  const app = Fastify({ logger: false });
  registerObservabilityMetrics(app, {
    appEnvironment: "development",
    database: harness.database,
    metricsAccessToken: DEVELOPMENT_METRICS_ACCESS_TOKEN,
    identityMtlsCert: certificatePem,
  });

  try {
    const body = await scrapeMetrics(app);
    assert.equal(
      metricValue(
        body,
        "daily_quiz_api_identity_mtls_certificate_expiry_timestamp_seconds",
      ),
      expectedExpiry,
    );
    assert.equal(body.includes(certificatePem), false);
    assert.equal(body.includes(certificate.subject), false);
  } finally {
    await app.close();
  }

  const invalidCertificateApp = Fastify({ logger: false });
  assert.throws(() => {
    registerObservabilityMetrics(invalidCertificateApp, {
      appEnvironment: "development",
      database: harness.database,
      metricsAccessToken: DEVELOPMENT_METRICS_ACCESS_TOKEN,
      identityMtlsCert:
        "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
    });
  });
  await invalidCertificateApp.close();
});

test("metrics aggregate database failures return a generic 503 envelope", async () => {
  const originalClient = harness.database.client;
  const sensitiveDatabaseError = "sensitive-database-connection-detail";
  harness.database.client = (() => {
    throw new Error(sensitiveDatabaseError);
  }) as unknown as Database["client"];

  const response = await (async () => {
    try {
      return await harness.app.inject({
        method: "GET",
        url: "/internal/metrics",
        headers: metricsAuthorization(),
      });
    } finally {
      harness.database.client = originalClient;
    }
  })();

  assert.equal(response.statusCode, 503, response.body);
  assert.deepEqual(response.json(), {
    code: "METRICS_UNAVAILABLE",
    message: "메트릭을 조회할 수 없습니다.",
    requestId: response.headers["x-request-id"],
    retryable: true,
  });
  assert.equal(response.body.includes(sensitiveDatabaseError), false);
  assert.equal(response.headers["cache-control"], "no-store");
});
