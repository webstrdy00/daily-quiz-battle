import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  DailyStartResponseSchema,
  CompleteAttemptResponseSchema,
} from "@daily-quiz-battle/contracts";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/client.js";
import { handleNetlifyRequest } from "../hosting/request-handler.js";
import {
  createIntegrationHarness,
  PRIMARY_DAY_NOON,
  type IntegrationHarness,
} from "./test-harness.js";

let harness: IntegrationHarness;
let limitedApp: FastifyInstance | undefined;

before(async () => {
  harness = await createIntegrationHarness();
  harness.app.get("/v1/adapter-test/query/:segment", async (request, reply) => {
    reply
      .status(201)
      .header("set-cookie", ["first=1; HttpOnly", "second=2; HttpOnly"]);
    return {
      method: request.method,
      url: request.raw.url,
      query: request.query,
      params: request.params,
      accept: request.headers.accept,
      requestId: request.id,
      ip: request.ip,
    };
  });
  const database = createDatabase(harness.config);
  try {
    limitedApp = await buildApp({
      config: { ...harness.config, rateLimitEnabled: true },
      database,
      clock: () => new Date(PRIMARY_DAY_NOON),
    });
  } catch (error) {
    await database.close();
    throw error;
  }
});

after(async () => {
  try {
    await limitedApp?.close();
  } finally {
    await harness?.close();
  }
});

function send(
  path: string,
  init: RequestInit = {},
  ip = "203.0.113.10",
  app = harness.app,
): Promise<Response> {
  return handleNetlifyRequest(
    app,
    new Request(`https://api.example.invalid${path}`, init),
    { ip },
  );
}

function jsonPost(
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const error = ApiErrorSchema.parse(await response.json());
  assert.equal(error.code, code);
  assert.equal(error.requestId, response.headers.get("x-request-id"));
}

test("Netlify Request adapter preserves bootstrap, authentication and idempotent batch completion", async () => {
  await expectError(
    await send("/v1/daily/start", jsonPost({})),
    401,
    "UNAUTHORIZED",
  );
  const bootstrap = await send(
    "/v1/auth/bootstrap",
    jsonPost({ anonymousKey: `dev-netlify-${randomUUID()}` }),
  );
  assert.equal(bootstrap.status, 200);
  const { accessToken } = BootstrapResponseSchema.parse(await bootstrap.json());
  const authorization = `Bearer ${accessToken}`;
  const startResponse = await send(
    "/v1/daily/start",
    jsonPost({}, { authorization }),
  );
  assert.equal(startResponse.status, 200);
  assert.equal(startResponse.headers.get("cache-control"), "no-store");
  const start = DailyStartResponseSchema.parse(await startResponse.json());
  assert.equal(start.status, "available");
  if (start.status !== "available") {
    assert.fail("fixture daily quiz must be available");
  }
  const body = {
    answers: start.questions.map((question) => ({
      sequence: question.sequence,
      questionRevisionId: question.revisionId,
      selectedIndex: 0,
    })),
  };
  const headers = { authorization, "idempotency-key": randomUUID() };
  const path = `/v1/attempts/${start.attempt.id}/complete`;
  const answer = await send(path, jsonPost(body, headers));
  assert.equal(answer.status, 200);
  const result = CompleteAttemptResponseSchema.parse(await answer.json());
  assert.equal(result.status, "completed");
  const replay = await send(
    path,
    jsonPost({ answers: [...body.answers].reverse() }, headers),
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(
    CompleteAttemptResponseSchema.parse(await replay.json()),
    result,
  );
  await expectError(
    await send(
      path,
      jsonPost(
        {
          answers: body.answers.map((answer, index) =>
            index === 4 ? { ...answer, selectedIndex: 1 } : answer,
          ),
        },
        headers,
      ),
    ),
    409,
    "IDEMPOTENCY_KEY_REUSED",
  );
  await expectError(
    await send(
      `/v1/attempts/${start.attempt.id}/answers`,
      jsonPost(body.answers[0], headers),
    ),
    404,
    "NOT_FOUND",
  );
});

test("Netlify streamed JSON retains Fastify malformed and oversized body handling", async () => {
  for (const body of [
    "{",
    "",
    JSON.stringify({ anonymousKey: "x".repeat(1_048_577) }),
  ]) {
    await expectError(
      await send("/v1/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      400,
      "INVALID_REQUEST",
    );
  }
  await expectError(
    await send("/v1/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "unsupported",
    }),
    415,
    "INVALID_REQUEST",
  );
});

test("Netlify adapter retains CORS preflight, HEAD and bodyless 204 semantics", async () => {
  const preflight = await send("/v1/auth/bootstrap", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-max-age"), "300");
  assert.equal(await preflight.text(), "");
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://localhost:5173",
  );
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /authorization/,
  );
  assert.equal(preflight.headers.get("cache-control"), "no-store");
  const head = await send("/health/live", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.match(head.headers.get("content-type") ?? "", /application\/json/);
  const deniedOrigin = await send("/health/live", {
    headers: { origin: "https://untrusted.example.invalid" },
  });
  assert.equal(deniedOrigin.headers.get("access-control-allow-origin"), null);
});

test("Netlify adapter preserves encoded path, repeated query, headers, status and cookies", async () => {
  const path = "/v1/adapter-test/query/a%20b?tag=one&tag=two&encoded=a%2Bb";
  const response = await send(
    path,
    {
      headers: {
        accept: "application/json",
        "x-request-id": "netlify-adapter-query",
        "x-forwarded-for": "192.0.2.1",
        "x-real-ip": "192.0.2.2",
        "x-nf-client-connection-ip": "192.0.2.3",
      },
    },
    "2001:db8::10",
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "netlify-adapter-query");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(response.headers.getSetCookie(), [
    "first=1; HttpOnly",
    "second=2; HttpOnly",
  ]);
  assert.deepEqual(await response.json(), {
    method: "GET",
    url: path,
    query: { tag: ["one", "two"], encoded: "a+b" },
    params: { segment: "a b" },
    accept: "application/json",
    requestId: "netlify-adapter-query",
    ip: "2001:db8::10",
  });
  await expectError(
    await send("/v1/does-not-exist?private=not-logged"),
    404,
    "NOT_FOUND",
  );
});

test("Netlify provider IP separates real rate-limit buckets and forged headers cannot evade them", async () => {
  assert.ok(limitedApp);
  const anonymousKey = `dev-netlify-rate-${randomUUID()}`;
  for (let index = 0; index < 31; index += 1) {
    const response = await send(
      "/v1/auth/bootstrap",
      jsonPost(
        { anonymousKey },
        {
          "x-forwarded-for": `192.0.2.${index + 1}`,
          "x-real-ip": `192.0.2.${index + 1}`,
          "x-nf-client-connection-ip": `192.0.2.${index + 1}`,
        },
      ),
      "203.0.113.40",
      limitedApp,
    );
    if (index < 30) {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    } else {
      await expectError(response, 429, "RATE_LIMITED");
      assert.ok(response.headers.get("retry-after"));
    }
  }
  const independent = await send(
    "/v1/auth/bootstrap",
    jsonPost({ anonymousKey }, { "x-forwarded-for": "203.0.113.40" }),
    "203.0.113.41",
    limitedApp,
  );
  assert.equal(independent.status, 200);
  BootstrapResponseSchema.parse(await independent.json());
});

test("Netlify adapter fails closed for absent or invalid provider IP despite forged headers", async () => {
  for (const ip of [
    undefined,
    "",
    "invalid",
    "203.0.113.10:443",
    "203.0.113.10, 192.0.2.1",
    " 203.0.113.10",
    "fe80::1%eth0",
  ]) {
    const response = await handleNetlifyRequest(
      harness.app,
      new Request("https://api.example.invalid/health/live", {
        headers: {
          "x-forwarded-for": "203.0.113.10",
          "x-nf-client-connection-ip": "203.0.113.10",
        },
      }),
      ip === undefined ? {} : { ip },
    );
    await expectError(response, 503, "INTERNAL_ERROR");
  }
  const head = await handleNetlifyRequest(
    harness.app,
    new Request("https://api.example.invalid/health/live", { method: "HEAD" }),
    {},
  );
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("cache-control"), "no-store");
});
