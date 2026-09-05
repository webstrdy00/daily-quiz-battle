import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { DEVELOPMENT_METRICS_ACCESS_TOKEN } from "../config.js";
import type { Database } from "../db/client.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

const RAW_ANONYMOUS_KEY = "dev-metrics-raw-anon-key-sensitive-value";
const RAW_APPLICATION_TOKEN = "metrics-raw-bearer-token-sensitive-value";
const PATH_UUID = randomUUID();
const CUSTOM_METRIC_FAMILIES = [
  "daily_quiz_api_http_request_duration_seconds",
  "daily_quiz_api_http_requests_total",
  "daily_quiz_api_notification_outbox_failed",
  "daily_quiz_api_notification_outbox_oldest_pending_age_seconds",
  "daily_quiz_api_notification_outbox_pending",
  "daily_quiz_api_operation_task_consecutive_failures",
  "daily_quiz_api_operation_task_last_success_age_seconds",
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
  assert.equal(body.includes('route="/health/live"'), false);
  assert.equal(body.includes('route="/internal/metrics"'), false);

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
    PATH_UUID,
    issuedAccessToken,
  ]) {
    assert.equal(body.includes(sensitiveValue), false, sensitiveValue);
  }
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
