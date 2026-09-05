import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  CreateReportResponseSchema,
  DailyStartResponseSchema,
  type CreateQuestionReportRequest,
  type DailyStartResponse,
} from "@daily-quiz-battle/contracts";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

interface JsonResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

interface StoredReportRow {
  id: string;
  reason_code: string;
  detail: string | null;
  created_at: Date | string;
  dedupe_window_start: Date | string;
  stored_report: Record<string, unknown>;
}

type AvailableDailyStart = Extract<DailyStartResponse, { status: "available" }>;

const FIRST_BUCKET_TIME = "2026-08-29T03:02:03.000Z";
const NEXT_BUCKET_TIME = "2026-08-29T03:10:00.000Z";
let harness: IntegrationHarness;
let inaccessibleRevisionId: string;

before(async () => {
  harness = await createIntegrationHarness();

  const questions = await harness.database.client<{ id: string }[]>`
    INSERT INTO questions DEFAULT VALUES
    RETURNING id
  `;
  const revisions = await harness.database.client<{ id: string }[]>`
    INSERT INTO question_revisions (
      question_id,
      revision_number,
      category,
      difficulty,
      prompt,
      choices,
      correct_index,
      explanation,
      source_url,
      source_checked_at,
      reviewer_id,
      lifecycle_status,
      published_at
    )
    VALUES (
      ${questions[0]!.id},
      1,
      'integration-test',
      'easy',
      'This published revision is not assigned to any daily set.',
      ${JSON.stringify(["one", "two", "three", "four"])}::jsonb,
      0,
      'This explanation must remain only in question content.',
      'https://example.invalid/inaccessible-question',
      ${FIRST_BUCKET_TIME},
      'report-integration-test',
      'published',
      ${FIRST_BUCKET_TIME}
    )
    RETURNING id
  `;
  inaccessibleRevisionId = revisions[0]!.id;
});

after(async () => {
  await harness?.close();
});

function authorizationHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function expectApiError(
  response: JsonResponse,
  statusCode: number,
  code: string,
): void {
  assert.equal(response.statusCode, statusCode, response.body);
  const error = ApiErrorSchema.parse(response.json());
  assert.equal(error.code, code);
}

async function bootstrapUser(anonymousKey: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(response.statusCode, 200, response.body);
  return BootstrapResponseSchema.parse(response.json()).accessToken;
}

async function startQuiz(token: string): Promise<AvailableDailyStart> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(token),
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  const start = DailyStartResponseSchema.parse(response.json());
  assert.equal(start.status, "available");
  return start as AvailableDailyStart;
}

async function createReport(
  token: string,
  payload: CreateQuestionReportRequest | Record<string, unknown>,
) {
  return harness.app.inject({
    method: "POST",
    url: "/v1/reports/questions",
    headers: authorizationHeaders(token),
    payload,
  });
}

test("question reports require authentication and conceal inaccessible revisions", async () => {
  harness.setNow(FIRST_BUCKET_TIME);

  const unauthenticated = await harness.app.inject({
    method: "POST",
    url: "/v1/reports/questions",
    payload: {
      questionRevisionId: inaccessibleRevisionId,
      reasonCode: "other",
    },
  });
  expectApiError(unauthenticated, 401, "UNAUTHORIZED");

  const token = await bootstrapUser("dev-it-report-inaccessible");
  await startQuiz(token);
  const inaccessible = await createReport(token, {
    questionRevisionId: inaccessibleRevisionId,
    reasonCode: "other",
    detail: "The caller must not learn whether this revision exists.",
  });
  expectApiError(inaccessible, 404, "QUESTION_NOT_FOUND");

  const rows = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM reports
    WHERE question_revision_id = ${inaccessibleRevisionId}
  `;
  assert.equal(rows[0]?.count, 0);
});

test("question report request validation returns the standard 400 error", async () => {
  harness.setNow(FIRST_BUCKET_TIME);
  const token = await bootstrapUser("dev-it-report-validation");
  const start = await startQuiz(token);
  const questionRevisionId = start.questions[0]!.revisionId;

  const invalidPayloads: Record<string, unknown>[] = [
    {
      questionRevisionId,
      reasonCode: "unsupported-reason",
    },
    {
      questionRevisionId,
      reasonCode: "other",
      detail: " \n ",
    },
    {
      questionRevisionId,
      reasonCode: "other",
      detail: "x".repeat(501),
    },
    {
      questionRevisionId: "not-a-uuid",
      reasonCode: "other",
    },
  ];

  for (const payload of invalidPayloads) {
    const response = await createReport(token, payload);
    expectApiError(response, 400, "INVALID_REQUEST");
  }
});

test("question reports trim detail, minimize stored data, and deduplicate by user, reason, and bucket", async () => {
  harness.setNow(FIRST_BUCKET_TIME);
  const ownerToken = await bootstrapUser("dev-it-report-owner");
  const otherToken = await bootstrapUser("dev-it-report-other-user");
  const ownerStart = await startQuiz(ownerToken);
  const otherStart = await startQuiz(otherToken);
  const questionRevisionId = ownerStart.questions[0]!.revisionId;
  assert.equal(otherStart.questions[0]!.revisionId, questionRevisionId);

  const firstResponse = await createReport(ownerToken, {
    questionRevisionId,
    reasonCode: "incorrect_answer",
    detail: "  The saved detail is trimmed.  ",
  });
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  const first = CreateReportResponseSchema.parse(firstResponse.json());
  assert.equal(first.deduplicated, false);
  assert.equal(first.createdAt, FIRST_BUCKET_TIME);

  const sequentialResponse = await createReport(ownerToken, {
    questionRevisionId,
    reasonCode: "incorrect_answer",
    detail: "A duplicate must not replace the first detail.",
  });
  assert.equal(sequentialResponse.statusCode, 200, sequentialResponse.body);
  const sequential = CreateReportResponseSchema.parse(
    sequentialResponse.json(),
  );
  assert.deepEqual(sequential, {
    id: first.id,
    deduplicated: true,
    createdAt: first.createdAt,
  });

  const concurrentDuplicates = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      createReport(ownerToken, {
        questionRevisionId,
        reasonCode: "incorrect_answer",
        detail: `Concurrent duplicate ${index + 1}`,
      }),
    ),
  );
  for (const response of concurrentDuplicates) {
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(CreateReportResponseSchema.parse(response.json()), {
      id: first.id,
      deduplicated: true,
      createdAt: first.createdAt,
    });
  }

  const concurrentOtherReasonResponses = await Promise.all(
    Array.from({ length: 8 }, () =>
      createReport(ownerToken, {
        questionRevisionId,
        reasonCode: "ambiguous",
      }),
    ),
  );
  for (const response of concurrentOtherReasonResponses) {
    assert.equal(response.statusCode, 200, response.body);
  }
  const concurrentOtherReason = concurrentOtherReasonResponses.map((response) =>
    CreateReportResponseSchema.parse(response.json()),
  );
  assert.equal(
    concurrentOtherReason.filter((report) => !report.deduplicated).length,
    1,
  );
  assert.equal(
    concurrentOtherReason.filter((report) => report.deduplicated).length,
    7,
  );
  assert.equal(
    new Set(concurrentOtherReason.map((report) => report.id)).size,
    1,
  );
  const otherReasonId = concurrentOtherReason[0]!.id;
  assert.notEqual(otherReasonId, first.id);

  const otherUserResponse = await createReport(otherToken, {
    questionRevisionId,
    reasonCode: "incorrect_answer",
  });
  assert.equal(otherUserResponse.statusCode, 200, otherUserResponse.body);
  const otherUser = CreateReportResponseSchema.parse(otherUserResponse.json());
  assert.equal(otherUser.deduplicated, false);
  assert.notEqual(otherUser.id, first.id);

  harness.setNow(NEXT_BUCKET_TIME);
  const nextBucketResponse = await createReport(ownerToken, {
    questionRevisionId,
    reasonCode: "incorrect_answer",
  });
  assert.equal(nextBucketResponse.statusCode, 200, nextBucketResponse.body);
  const nextBucket = CreateReportResponseSchema.parse(
    nextBucketResponse.json(),
  );
  assert.equal(nextBucket.deduplicated, false);
  assert.equal(nextBucket.createdAt, NEXT_BUCKET_TIME);
  assert.notEqual(nextBucket.id, first.id);

  const rows = await harness.database.client<StoredReportRow[]>`
    SELECT
      r.id,
      r.reason_code,
      r.detail,
      r.created_at,
      r.dedupe_window_start,
      to_jsonb(r) AS stored_report
    FROM reports r
    WHERE r.question_revision_id = ${questionRevisionId}
    ORDER BY r.created_at, r.id
  `;
  assert.equal(rows.length, 4);
  assert.deepEqual(
    new Set(rows.map((row) => row.id)),
    new Set([first.id, otherReasonId, otherUser.id, nextBucket.id]),
  );

  const firstRow = rows.find((row) => row.id === first.id);
  assert.ok(firstRow);
  assert.equal(firstRow.detail, "The saved detail is trimmed.");
  assert.equal(new Date(firstRow.created_at).toISOString(), FIRST_BUCKET_TIME);
  assert.equal(
    new Date(firstRow.dedupe_window_start).toISOString(),
    "2026-08-29T03:00:00.000Z",
  );

  const nextBucketRow = rows.find((row) => row.id === nextBucket.id);
  assert.ok(nextBucketRow);
  assert.equal(
    new Date(nextBucketRow.dedupe_window_start).toISOString(),
    NEXT_BUCKET_TIME,
  );

  const storedReportKeys = [
    "challenge_id",
    "created_at",
    "dedupe_window_start",
    "detail",
    "id",
    "question_revision_id",
    "reason_code",
    "reporter_user_id",
  ];
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.stored_report).sort(), storedReportKeys);
    assert.equal("prompt" in row.stored_report, false);
    assert.equal("choices" in row.stored_report, false);
    assert.equal("correct_index" in row.stored_report, false);
    assert.equal("explanation" in row.stored_report, false);
  }
});
