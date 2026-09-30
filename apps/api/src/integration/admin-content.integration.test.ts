import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  AdminCreateDailySetDraftResponseSchema,
  AdminCreateQuestionRevisionResponseSchema,
  AdminListAuditLogsResponseSchema,
  AdminListDailySetsResponseSchema,
  AdminListQuestionRevisionsResponseSchema,
  AdminPublishDailySetResponseSchema,
  AdminUpdateQuestionRevisionStatusResponseSchema,
  AdminVoidDailySetResponseSchema,
  ApiErrorSchema,
  BootstrapResponseSchema,
  UuidSchema,
  type AdminCreateQuestionRevisionRequest,
  type AdminCreateQuestionRevisionResponse,
  type ContentStatus,
  type Difficulty,
} from "@daily-quiz-battle/contracts";
import { createAdminAccessTokenService } from "../admin/token.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

interface JsonResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

interface PublishedRevision extends AdminCreateQuestionRevisionResponse {
  category: string;
  difficulty: Difficulty;
}

const ADMIN_CONTENT_URL = "/v1/admin/content";
const DEFAULT_CLOCK = "2037-01-01T00:00:00.000Z";
const DEFAULT_SOURCE_CHECKED_AT = "2036-12-01T00:00:00.000Z";
const CHOICE_ORDER = [0, 1, 2, 3] as const;
let harness: IntegrationHarness;

before(async () => {
  harness = await createIntegrationHarness();
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

function questionPayload(
  suffix: string,
  difficulty: Difficulty = "easy",
  category = `category-${suffix}`,
  overrides: Partial<AdminCreateQuestionRevisionRequest> = {},
): AdminCreateQuestionRevisionRequest {
  return {
    category,
    difficulty,
    prompt: `Sensitive prompt ${suffix}`,
    choices: [
      `Sensitive choice A ${suffix}`,
      `Sensitive choice B ${suffix}`,
      `Sensitive choice C ${suffix}`,
      `Sensitive choice D ${suffix}`,
    ],
    correctIndex: 2,
    explanation: `Sensitive explanation ${suffix}`,
    sourceUrl: `https://example.com/content/${suffix}`,
    sourceCheckedAt: DEFAULT_SOURCE_CHECKED_AT,
    reviewerId: `reviewer-${suffix}`,
    timeSensitive: false,
    validUntil: null,
    nextReviewAt: null,
    ...overrides,
  };
}

async function issueAdminToken(
  actorSubject: string,
  scopes: string[] = ["content:write"],
): Promise<string> {
  return createAdminAccessTokenService(harness.config).issue({
    actorSubject,
    scopes,
  });
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

async function createRevision(
  token: string,
  payload: AdminCreateQuestionRevisionRequest,
): Promise<AdminCreateQuestionRevisionResponse> {
  const response = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    headers: authorizationHeaders(token),
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  return AdminCreateQuestionRevisionResponseSchema.parse(response.json());
}

async function updateRevisionStatus(
  token: string,
  revisionId: string,
  status: ContentStatus,
) {
  const response = await harness.app.inject({
    method: "PATCH",
    url: `${ADMIN_CONTENT_URL}/question-revisions/${revisionId}/status`,
    headers: authorizationHeaders(token),
    payload: { status },
  });
  assert.equal(response.statusCode, 200, response.body);
  return AdminUpdateQuestionRevisionStatusResponseSchema.parse(response.json());
}

async function publishRevision(
  token: string,
  suffix: string,
  difficulty: Difficulty,
  category: string,
  overrides: Partial<AdminCreateQuestionRevisionRequest> = {},
): Promise<PublishedRevision> {
  const created = await createRevision(
    token,
    questionPayload(suffix, difficulty, category, overrides),
  );
  await updateRevisionStatus(token, created.revisionId, "review");
  await updateRevisionStatus(token, created.revisionId, "approved");
  await updateRevisionStatus(token, created.revisionId, "published");
  return { ...created, category, difficulty };
}

function dailyItems(revisions: readonly PublishedRevision[]) {
  assert.equal(revisions.length, 5);
  return revisions.map((revision) => ({
    revisionId: revision.revisionId,
    choiceOrder: CHOICE_ORDER,
  })) as [
    { revisionId: string; choiceOrder: typeof CHOICE_ORDER },
    { revisionId: string; choiceOrder: typeof CHOICE_ORDER },
    { revisionId: string; choiceOrder: typeof CHOICE_ORDER },
    { revisionId: string; choiceOrder: typeof CHOICE_ORDER },
    { revisionId: string; choiceOrder: typeof CHOICE_ORDER },
  ];
}

async function createDailySet(
  token: string,
  quizDate: string,
  revisions: readonly PublishedRevision[],
) {
  const response = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/daily-sets`,
    headers: authorizationHeaders(token),
    payload: { quizDate, items: dailyItems(revisions) },
  });
  assert.equal(response.statusCode, 200, response.body);
  return AdminCreateDailySetDraftResponseSchema.parse(response.json());
}

async function publishDailySet(token: string, dailySetId: string) {
  return harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/daily-sets/${dailySetId}/publish`,
    headers: authorizationHeaders(token),
    payload: {},
  });
}

test("admin content routes enforce the admin-token and scope boundary", async () => {
  harness.setNow("2034-01-01T00:00:00.000Z");
  const payload = questionPayload("auth-boundary", "easy", "auth-boundary");

  const unauthenticated = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    payload,
  });
  expectApiError(unauthenticated, 401, "ADMIN_UNAUTHORIZED");

  const userToken = await bootstrapUser("dev-admin-content-user-boundary");
  const userCredential = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    headers: authorizationHeaders(userToken),
    payload,
  });
  expectApiError(userCredential, 401, "ADMIN_UNAUTHORIZED");

  const invalidCredential = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    headers: authorizationHeaders("not-an-admin-token"),
    payload,
  });
  expectApiError(invalidCredential, 401, "ADMIN_UNAUTHORIZED");

  const readOnlyToken = await issueAdminToken("admin-auth-read-only", [
    "reports:read",
  ]);
  const insufficientScope = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    headers: authorizationHeaders(readOnlyToken),
    payload,
  });
  expectApiError(insufficientScope, 403, "ADMIN_FORBIDDEN");

  const writerToken = await issueAdminToken("admin-auth-writer");
  const allowed = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    headers: authorizationHeaders(writerToken),
    payload,
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  const created = AdminCreateQuestionRevisionResponseSchema.parse(
    allowed.json(),
  );
  assert.equal(created.status, "draft");
  assert.equal(created.revisionNumber, 1);
});

test("logical revisions converge under concurrency and lifecycle transitions are enforced", async () => {
  harness.setNow("2035-01-10T00:00:00.000Z");
  const token = await issueAdminToken("admin-lifecycle-writer");
  const original = await createRevision(
    token,
    questionPayload("lifecycle-original", "medium", "lifecycle-unique", {
      sourceCheckedAt: "2035-01-01T00:00:00.000Z",
    }),
  );

  const concurrent = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      harness.app.inject({
        method: "POST",
        url: `${ADMIN_CONTENT_URL}/question-revisions`,
        headers: authorizationHeaders(token),
        payload: questionPayload(
          `lifecycle-concurrent-${index + 1}`,
          "medium",
          "lifecycle-unique",
          { questionId: original.questionId },
        ),
      }),
    ),
  );
  assert.ok(
    concurrent.every((response) => response.statusCode === 200),
    concurrent.map((response) => response.body).join("\n"),
  );
  const concurrentRevisions = concurrent.map((response) =>
    AdminCreateQuestionRevisionResponseSchema.parse(response.json()),
  );
  assert.deepEqual(
    concurrentRevisions
      .map((revision) => revision.revisionNumber)
      .sort((left, right) => left - right),
    [2, 3, 4, 5, 6, 7],
  );
  assert.ok(
    concurrentRevisions.every(
      (revision) => revision.questionId === original.questionId,
    ),
  );

  const persisted = await harness.database.client<
    { revision_number: number }[]
  >`
    SELECT revision_number::int AS revision_number
    FROM question_revisions
    WHERE question_id = ${original.questionId}
    ORDER BY revision_number
  `;
  assert.deepEqual(
    persisted.map((row) => row.revision_number),
    [1, 2, 3, 4, 5, 6, 7],
  );

  const invalidDirectTransition = await harness.app.inject({
    method: "PATCH",
    url: `${ADMIN_CONTENT_URL}/question-revisions/${original.revisionId}/status`,
    headers: authorizationHeaders(token),
    payload: { status: "approved" },
  });
  expectApiError(
    invalidDirectTransition,
    409,
    "QUESTION_REVISION_STATUS_TRANSITION_INVALID",
  );

  await updateRevisionStatus(token, original.revisionId, "review");
  await updateRevisionStatus(token, original.revisionId, "approved");

  await assert.rejects(async () => {
    await harness.database.client`
        UPDATE question_revisions
        SET
          lifecycle_status = 'published',
          published_at = ${"2035-01-10T00:00:00.000Z"},
          prompt = ${"Mutated during publish"}
        WHERE id = ${original.revisionId}
      `;
  }, /published question revisions are immutable/);
  const unchangedApproved = await harness.database.client<
    { status: string; prompt: string }[]
  >`
    SELECT lifecycle_status::text AS status, prompt
    FROM question_revisions
    WHERE id = ${original.revisionId}
  `;
  assert.deepEqual(unchangedApproved[0], {
    status: "approved",
    prompt: "Sensitive prompt lifecycle-original",
  });

  const published = await updateRevisionStatus(
    token,
    original.revisionId,
    "published",
  );
  assert.equal(published.publishedAt, "2035-01-10T00:00:00.000Z");
  assert.equal(published.retiredAt, null);

  harness.setNow("2035-01-11T00:00:00.000Z");
  const retired = await updateRevisionStatus(
    token,
    original.revisionId,
    "retired",
  );
  assert.equal(retired.publishedAt, "2035-01-10T00:00:00.000Z");
  assert.equal(retired.retiredAt, "2035-01-11T00:00:00.000Z");

  const terminalTransition = await harness.app.inject({
    method: "PATCH",
    url: `${ADMIN_CONTENT_URL}/question-revisions/${original.revisionId}/status`,
    headers: authorizationHeaders(token),
    payload: { status: "published" },
  });
  expectApiError(
    terminalTransition,
    409,
    "QUESTION_REVISION_STATUS_TRANSITION_INVALID",
  );
});

test("time-sensitive fields are required and expired revisions cannot be published", async () => {
  harness.setNow("2036-03-01T00:00:00.000Z");
  const token = await issueAdminToken("admin-time-sensitive-writer");
  const missingValidity = questionPayload(
    "time-sensitive-missing",
    "hard",
    "time-sensitive-unique",
    { timeSensitive: true },
  );
  const invalidFields = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    headers: authorizationHeaders(token),
    payload: missingValidity,
  });
  expectApiError(invalidFields, 400, "INVALID_REQUEST");

  const validUntil = "2036-03-02T00:00:00.000Z";
  const nextReviewAt = "2036-03-01T12:00:00.000Z";
  const created = await createRevision(
    token,
    questionPayload("time-sensitive-expiry", "hard", "time-sensitive-unique", {
      sourceCheckedAt: "2036-02-20T00:00:00.000Z",
      timeSensitive: true,
      validUntil,
      nextReviewAt,
    }),
  );
  await updateRevisionStatus(token, created.revisionId, "review");
  await updateRevisionStatus(token, created.revisionId, "approved");

  const stored = await harness.database.client<
    {
      time_sensitive: boolean;
      valid_until: Date | string;
      next_review_at: Date | string;
    }[]
  >`
    SELECT time_sensitive, valid_until, next_review_at
    FROM question_revisions
    WHERE id = ${created.revisionId}
  `;
  assert.equal(stored[0]?.time_sensitive, true);
  assert.equal(new Date(stored[0]!.valid_until).toISOString(), validUntil);
  assert.equal(new Date(stored[0]!.next_review_at).toISOString(), nextReviewAt);

  harness.setNow(validUntil);
  const expiredPublish = await harness.app.inject({
    method: "PATCH",
    url: `${ADMIN_CONTENT_URL}/question-revisions/${created.revisionId}/status`,
    headers: authorizationHeaders(token),
    payload: { status: "published" },
  });
  expectApiError(expiredPublish, 422, "QUESTION_REVISION_VALIDITY_EXPIRED");

  const state = await harness.database.client<{ status: string }[]>`
    SELECT lifecycle_status::text AS status
    FROM question_revisions
    WHERE id = ${created.revisionId}
  `;
  assert.equal(state[0]?.status, "approved");
});

test("daily composition, publication rules, rolling uniqueness, validity, and audit minimization", async () => {
  harness.setNow(DEFAULT_CLOCK);
  const actorSubject = "admin-daily-composition-writer";
  const token = await issueAdminToken(actorSubject);

  const baseline = await Promise.all([
    publishRevision(token, "daily-a", "easy", "  DAILY-ALPHA  "),
    publishRevision(token, "daily-b", "easy", "daily-alpha"),
    publishRevision(token, "daily-c", "medium", "daily-beta"),
    publishRevision(token, "daily-d", "medium", "daily-beta"),
    publishRevision(token, "daily-e", "hard", "daily-gamma"),
  ]);
  const invalidCalendarDate = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/daily-sets`,
    headers: authorizationHeaders(token),
    payload: {
      quizDate: "2037-02-30",
      items: dailyItems(baseline),
    },
  });
  expectApiError(invalidCalendarDate, 400, "INVALID_REQUEST");

  const happyDraft = await createDailySet(token, "2037-02-01", baseline);
  assert.equal(
    new Set(happyDraft.items.map((item) => item.revisionId)).size,
    5,
  );
  const happyPublishResponse = await publishDailySet(
    token,
    happyDraft.dailySetId,
  );
  assert.equal(happyPublishResponse.statusCode, 200, happyPublishResponse.body);
  const happyPublished = AdminPublishDailySetResponseSchema.parse(
    happyPublishResponse.json(),
  );
  assert.equal(happyPublished.status, "published");
  assert.equal(happyPublished.publishedAt, DEFAULT_CLOCK);

  const composition = await harness.database.client<
    {
      item_count: number;
      distinct_revision_count: number;
      easy_count: number;
      medium_count: number;
      hard_count: number;
      maximum_category_count: number;
    }[]
  >`
    SELECT
      count(*)::int AS item_count,
      count(DISTINCT qr.id)::int AS distinct_revision_count,
      count(*) FILTER (WHERE qr.difficulty = 'easy')::int AS easy_count,
      count(*) FILTER (WHERE qr.difficulty = 'medium')::int AS medium_count,
      count(*) FILTER (WHERE qr.difficulty = 'hard')::int AS hard_count,
      (
        SELECT max(category_count)::int
        FROM (
          SELECT count(*)::int AS category_count
          FROM daily_set_items category_items
          JOIN question_revisions category_revisions
            ON category_revisions.id = category_items.question_revision_id
          WHERE category_items.daily_set_id = ${happyDraft.dailySetId}
          GROUP BY category_revisions.category
        ) category_counts
      ) AS maximum_category_count
    FROM daily_set_items dsi
    JOIN question_revisions qr ON qr.id = dsi.question_revision_id
    WHERE dsi.daily_set_id = ${happyDraft.dailySetId}
  `;
  assert.deepEqual(composition[0], {
    item_count: 5,
    distinct_revision_count: 5,
    easy_count: 2,
    medium_count: 2,
    hard_count: 1,
    maximum_category_count: 2,
  });

  const duplicateRevision = await harness.app.inject({
    method: "POST",
    url: `${ADMIN_CONTENT_URL}/daily-sets`,
    headers: authorizationHeaders(token),
    payload: {
      quizDate: "2037-02-02",
      items: dailyItems([
        baseline[0]!,
        baseline[0]!,
        baseline[2]!,
        baseline[3]!,
        baseline[4]!,
      ]),
    },
  });
  expectApiError(duplicateRevision, 422, "DAILY_SET_REVISIONS_NOT_DISTINCT");

  const categoryReplacement = await publishRevision(
    token,
    "daily-f-category",
    "hard",
    "daily-alpha",
  );
  const difficultyReplacement = await publishRevision(
    token,
    "daily-g-difficulty",
    "easy",
    "daily-gamma",
  );

  const badDifficultyDraft = await createDailySet(token, "2037-02-03", [
    baseline[0]!,
    baseline[1]!,
    baseline[2]!,
    baseline[3]!,
    difficultyReplacement,
  ]);
  const badDifficultyPublish = await publishDailySet(
    token,
    badDifficultyDraft.dailySetId,
  );
  expectApiError(
    badDifficultyPublish,
    422,
    "DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID",
  );

  const badCategoryDraft = await createDailySet(token, "2037-02-04", [
    baseline[0]!,
    baseline[1]!,
    baseline[2]!,
    baseline[3]!,
    categoryReplacement,
  ]);
  const badCategoryPublish = await publishDailySet(
    token,
    badCategoryDraft.dailySetId,
  );
  expectApiError(badCategoryPublish, 422, "DAILY_SET_CATEGORY_LIMIT_EXCEEDED");

  const repeatedLogicalRevision = await createRevision(
    token,
    questionPayload("daily-a-revision-2", "easy", "daily-alpha", {
      questionId: baseline[0]!.questionId,
    }),
  );
  await updateRevisionStatus(
    token,
    repeatedLogicalRevision.revisionId,
    "review",
  );
  await updateRevisionStatus(
    token,
    repeatedLogicalRevision.revisionId,
    "approved",
  );
  await updateRevisionStatus(
    token,
    repeatedLogicalRevision.revisionId,
    "published",
  );
  const repeatedLogical: PublishedRevision = {
    ...repeatedLogicalRevision,
    category: "daily-alpha",
    difficulty: "easy",
  };
  const recentMediumOne = await publishRevision(
    token,
    "daily-h-recent",
    "medium",
    "daily-beta",
  );
  const recentMediumTwo = await publishRevision(
    token,
    "daily-i-recent",
    "medium",
    "daily-gamma",
  );
  const duplicateLogicalDraft = await createDailySet(token, "2037-03-01", [
    baseline[0]!,
    repeatedLogical,
    recentMediumOne,
    recentMediumTwo,
    baseline[4]!,
  ]);
  const duplicateLogicalPublish = await publishDailySet(
    token,
    duplicateLogicalDraft.dailySetId,
  );
  expectApiError(
    duplicateLogicalPublish,
    422,
    "DAILY_SET_LOGICAL_QUESTIONS_NOT_DISTINCT",
  );

  const recentDraft = await createDailySet(token, "2037-02-10", [
    repeatedLogical,
    difficultyReplacement,
    recentMediumOne,
    recentMediumTwo,
    categoryReplacement,
  ]);
  const recentPublish = await publishDailySet(token, recentDraft.dailySetId);
  expectApiError(
    recentPublish,
    422,
    "DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED",
  );

  const expiringRevision = await publishRevision(
    token,
    "daily-j-expiring",
    "easy",
    "daily-delta",
    {
      timeSensitive: true,
      validUntil: "2037-02-19T00:00:00.000Z",
      nextReviewAt: "2037-01-05T00:00:00.000Z",
    },
  );
  const expiringDraft = await createDailySet(token, "2037-02-20", [
    difficultyReplacement,
    expiringRevision,
    recentMediumOne,
    recentMediumTwo,
    categoryReplacement,
  ]);
  const expiredDailyPublish = await publishDailySet(
    token,
    expiringDraft.dailySetId,
  );
  expectApiError(
    expiredDailyPublish,
    422,
    "DAILY_SET_REVISION_VALIDITY_EXPIRED",
  );

  const reverseDateToken = await issueAdminToken("admin-reverse-date-writer");
  const reverseDateRevisions = await Promise.all([
    publishRevision(
      reverseDateToken,
      "reverse-date-a",
      "easy",
      "reverse-alpha",
    ),
    publishRevision(
      reverseDateToken,
      "reverse-date-b",
      "easy",
      "reverse-alpha",
    ),
    publishRevision(
      reverseDateToken,
      "reverse-date-c",
      "medium",
      "reverse-beta",
    ),
    publishRevision(
      reverseDateToken,
      "reverse-date-d",
      "medium",
      "reverse-beta",
    ),
    publishRevision(
      reverseDateToken,
      "reverse-date-e",
      "hard",
      "reverse-gamma",
    ),
  ]);
  const laterDraft = await createDailySet(
    reverseDateToken,
    "2037-04-15",
    reverseDateRevisions,
  );
  const laterPublish = await publishDailySet(
    reverseDateToken,
    laterDraft.dailySetId,
  );
  assert.equal(laterPublish.statusCode, 200, laterPublish.body);

  const earlierDraft = await createDailySet(
    reverseDateToken,
    "2037-04-05",
    reverseDateRevisions,
  );
  const reverseDatePublish = await publishDailySet(
    reverseDateToken,
    earlierDraft.dailySetId,
  );
  expectApiError(
    reverseDatePublish,
    422,
    "DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED",
  );

  const auditRows = await harness.database.client<
    {
      actor_subject: string;
      action: string;
      resource_type: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }[]
  >`
    SELECT actor_subject, action, resource_type, resource_id, metadata
    FROM admin_audit_logs
    WHERE actor_subject = ${actorSubject}
    ORDER BY created_at, id
  `;
  assert.equal(auditRows.length, 51);
  assert.deepEqual(
    Object.fromEntries(
      [
        "question_revision.create",
        "question_revision.status.update",
        "daily_set.create",
        "daily_set.publish",
      ].map((action) => [
        action,
        auditRows.filter((row) => row.action === action).length,
      ]),
    ),
    {
      "question_revision.create": 11,
      "question_revision.status.update": 33,
      "daily_set.create": 6,
      "daily_set.publish": 1,
    },
  );
  for (const row of auditRows) {
    assert.equal(row.actor_subject, actorSubject);
    assert.ok(row.action.length > 0);
    assert.ok(["question_revision", "daily_set"].includes(row.resource_type));
    UuidSchema.parse(row.resource_id);
    assert.equal(row.metadata.action, row.action);
    const serializedMetadata = JSON.stringify(row.metadata);
    assert.doesNotMatch(
      serializedMetadata,
      /prompt|choices|correctIndex|explanation|source|token/i,
    );
    assert.equal(serializedMetadata.includes(token), false);
    assert.equal(
      serializedMetadata.includes("Sensitive prompt daily-a"),
      false,
    );
    assert.equal(
      serializedMetadata.includes("Sensitive choice A daily-a"),
      false,
    );
    assert.equal(
      serializedMetadata.includes("Sensitive explanation daily-a"),
      false,
    );
    assert.equal(
      serializedMetadata.includes("https://example.com/content/daily-a"),
      false,
    );
  }
});

test("admin content reads enforce the existing content-write boundary", async () => {
  const urls = [
    `${ADMIN_CONTENT_URL}/question-revisions`,
    `${ADMIN_CONTENT_URL}/daily-sets?from=2040-01-01&to=2040-01-02`,
    `${ADMIN_CONTENT_URL}/audit-logs`,
  ];
  for (const url of urls) {
    const unauthenticated = await harness.app.inject({ method: "GET", url });
    expectApiError(unauthenticated, 401, "ADMIN_UNAUTHORIZED");
  }

  const userToken = await bootstrapUser("dev-admin-content-read-user");
  const userCredential = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/question-revisions`,
    headers: authorizationHeaders(userToken),
  });
  expectApiError(userCredential, 401, "ADMIN_UNAUTHORIZED");

  const readOnlyToken = await issueAdminToken("admin-content-reader", [
    "reports:read",
  ]);
  const insufficientScope = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/audit-logs`,
    headers: authorizationHeaders(readOnlyToken),
  });
  expectApiError(insufficientScope, 403, "ADMIN_FORBIDDEN");
});

test("admin content reads validate, filter, and keyset-page CMS data", async () => {
  harness.setNow("2040-01-10T00:00:00.000Z");
  const actorSubject = "admin-cms-read-writer";
  const token = await issueAdminToken(actorSubject);
  const reviewPayloads = [
    questionPayload("cms-read-a", "easy", "  CMS-READ-ALPHA  "),
    questionPayload("cms-read-b", "easy", "cms-read-alpha"),
    questionPayload("cms-read-c", "medium", "cms-read-beta"),
  ];
  const reviewRevisions = [];
  for (const payload of reviewPayloads) {
    const revision = await createRevision(token, payload);
    await updateRevisionStatus(token, revision.revisionId, "review");
    reviewRevisions.push(revision);
  }
  const reviewRevisionIds = reviewRevisions.map(
    (revision) => revision.revisionId,
  );
  await harness.database.client`
    UPDATE question_revisions
    SET created_at = ${"2040-01-03T00:00:00.000Z"}
    WHERE id IN ${harness.database.client(reviewRevisionIds)}
  `;

  const expectedRevisionOrder = [...reviewRevisionIds].sort((left, right) =>
    left < right ? 1 : left > right ? -1 : 0,
  );
  const firstRevisionPageResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/question-revisions?status=review&limit=2`,
    headers: authorizationHeaders(token),
  });
  assert.equal(
    firstRevisionPageResponse.statusCode,
    200,
    firstRevisionPageResponse.body,
  );
  const firstRevisionPage = AdminListQuestionRevisionsResponseSchema.parse(
    firstRevisionPageResponse.json(),
  );
  assert.deepEqual(
    firstRevisionPage.questionRevisions.map((revision) => revision.revisionId),
    expectedRevisionOrder.slice(0, 2),
  );
  assert.ok(
    firstRevisionPage.questionRevisions.every(
      (revision) => revision.status === "review",
    ),
  );
  assert.ok(
    firstRevisionPage.questionRevisions.every(
      (revision) =>
        revision.category === revision.category.trim().toLowerCase(),
    ),
  );
  assert.ok(
    firstRevisionPage.questionRevisions.every(
      (revision) =>
        revision.prompt.length > 0 &&
        revision.sourceUrl.startsWith("https://example.com/content/") &&
        revision.sourceCheckedAt === DEFAULT_SOURCE_CHECKED_AT &&
        revision.reviewerId.startsWith("reviewer-") &&
        revision.createdAt === "2040-01-03T00:00:00.000Z",
    ),
  );
  assert.notEqual(firstRevisionPage.nextCursor, null);

  const secondRevisionPageResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/question-revisions?status=review&limit=2&cursor=${encodeURIComponent(
      firstRevisionPage.nextCursor!,
    )}`,
    headers: authorizationHeaders(token),
  });
  assert.equal(
    secondRevisionPageResponse.statusCode,
    200,
    secondRevisionPageResponse.body,
  );
  const secondRevisionPage = AdminListQuestionRevisionsResponseSchema.parse(
    secondRevisionPageResponse.json(),
  );
  assert.equal(
    secondRevisionPage.questionRevisions[0]?.revisionId,
    expectedRevisionOrder[2],
  );
  assert.equal(
    secondRevisionPage.questionRevisions.some((revision) =>
      firstRevisionPage.questionRevisions.some(
        (firstRevision) => firstRevision.revisionId === revision.revisionId,
      ),
    ),
    false,
  );

  for (const revision of reviewRevisions) {
    await updateRevisionStatus(token, revision.revisionId, "approved");
    await updateRevisionStatus(token, revision.revisionId, "published");
  }
  const finalRevisions = await Promise.all([
    publishRevision(token, "cms-read-d", "medium", "cms-read-beta"),
    publishRevision(token, "cms-read-e", "hard", "cms-read-gamma"),
  ]);
  const publishedRevisions: PublishedRevision[] = [
    {
      ...reviewRevisions[0]!,
      category: "cms-read-alpha",
      difficulty: "easy",
    },
    {
      ...reviewRevisions[1]!,
      category: "cms-read-alpha",
      difficulty: "easy",
    },
    {
      ...reviewRevisions[2]!,
      category: "cms-read-beta",
      difficulty: "medium",
    },
    ...finalRevisions,
  ];
  const firstDailySet = await createDailySet(
    token,
    "2040-02-01",
    publishedRevisions,
  );
  const secondDailySet = await createDailySet(
    token,
    "2040-02-02",
    publishedRevisions,
  );

  const dailySetsResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/daily-sets?from=2040-02-01&to=2040-02-02&status=draft`,
    headers: authorizationHeaders(token),
  });
  assert.equal(dailySetsResponse.statusCode, 200, dailySetsResponse.body);
  const dailySets = AdminListDailySetsResponseSchema.parse(
    dailySetsResponse.json(),
  ).dailySets;
  assert.deepEqual(
    dailySets.map((dailySet) => dailySet.quizDate),
    ["2040-02-02", "2040-02-01"],
  );
  assert.ok(dailySets.every((dailySet) => dailySet.status === "draft"));
  assert.ok(dailySets.every((dailySet) => dailySet.items.length === 5));
  assert.deepEqual(
    dailySets[0]?.items.map((item) => item.position),
    [1, 2, 3, 4, 5],
  );
  assert.ok(
    dailySets.every((dailySet) =>
      dailySet.items.every(
        (item) =>
          item.revision.status === "published" &&
          item.revision.prompt.startsWith("Sensitive prompt cms-read-"),
      ),
    ),
  );

  const invalidRequests = await Promise.all([
    harness.app.inject({
      method: "GET",
      url: `${ADMIN_CONTENT_URL}/question-revisions?status=unknown`,
      headers: authorizationHeaders(token),
    }),
    harness.app.inject({
      method: "GET",
      url: `${ADMIN_CONTENT_URL}/question-revisions?limit=101`,
      headers: authorizationHeaders(token),
    }),
    harness.app.inject({
      method: "GET",
      url: `${ADMIN_CONTENT_URL}/question-revisions?cursor=bm90LWpzb24`,
      headers: authorizationHeaders(token),
    }),
    harness.app.inject({
      method: "GET",
      url: `${ADMIN_CONTENT_URL}/daily-sets?from=2040-01-01&to=2040-04-01`,
      headers: authorizationHeaders(token),
    }),
    harness.app.inject({
      method: "GET",
      url: `${ADMIN_CONTENT_URL}/daily-sets?from=2040-02-02&to=2040-02-01`,
      headers: authorizationHeaders(token),
    }),
    harness.app.inject({
      method: "GET",
      url: `${ADMIN_CONTENT_URL}/audit-logs?limit=0`,
      headers: authorizationHeaders(token),
    }),
  ]);
  for (const response of invalidRequests) {
    expectApiError(response, 400, "INVALID_REQUEST");
  }

  const dailySetIds = [firstDailySet.dailySetId, secondDailySet.dailySetId];
  await harness.database.client`
    UPDATE admin_audit_logs
    SET created_at = ${"2042-01-01T00:00:00.000Z"}
    WHERE resource_type = 'daily_set'
      AND resource_id IN ${harness.database.client(dailySetIds)}
  `;
  const expectedAuditRows = await harness.database.client<
    { resource_id: string }[]
  >`
    SELECT resource_id
    FROM admin_audit_logs
    WHERE resource_type = 'daily_set'
      AND resource_id IN ${harness.database.client(dailySetIds)}
    ORDER BY created_at DESC, id DESC
  `;
  const expectedAuditOrder = expectedAuditRows.map((row) => row.resource_id);
  const firstAuditPageResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/audit-logs?limit=1`,
    headers: authorizationHeaders(token),
  });
  assert.equal(
    firstAuditPageResponse.statusCode,
    200,
    firstAuditPageResponse.body,
  );
  const firstAuditPage = AdminListAuditLogsResponseSchema.parse(
    firstAuditPageResponse.json(),
  );
  const firstAuditLog = firstAuditPage.auditLogs[0];
  assert.ok(firstAuditLog);
  assert.deepEqual(Object.keys(firstAuditLog).sort(), [
    "action",
    "actorSubject",
    "createdAt",
    "metadata",
    "resourceId",
    "resourceType",
  ]);
  assert.equal(firstAuditLog.actorSubject, actorSubject);
  assert.equal(firstAuditLog.action, "daily_set.create");
  assert.equal(firstAuditLog.resourceType, "daily_set");
  assert.equal(firstAuditLog.resourceId, expectedAuditOrder[0]);
  assert.equal(firstAuditLog.createdAt, "2042-01-01T00:00:00.000Z");
  assert.deepEqual(firstAuditLog.metadata, {
    action: "daily_set.create",
    status: "draft",
  });
  assert.equal(JSON.stringify(firstAuditPage).includes(token), false);
  assert.doesNotMatch(
    JSON.stringify(firstAuditPage),
    /prompt|choices|correctIndex|explanation|sourceUrl/i,
  );
  assert.notEqual(firstAuditPage.nextCursor, null);

  const secondAuditPageResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/audit-logs?limit=1&cursor=${encodeURIComponent(
      firstAuditPage.nextCursor!,
    )}`,
    headers: authorizationHeaders(token),
  });
  assert.equal(
    secondAuditPageResponse.statusCode,
    200,
    secondAuditPageResponse.body,
  );
  const secondAuditPage = AdminListAuditLogsResponseSchema.parse(
    secondAuditPageResponse.json(),
  );
  assert.equal(secondAuditPage.auditLogs[0]?.resourceId, expectedAuditOrder[1]);
});

test("daily-set void requires its dedicated scope and is immutable, replayable, and listable", async () => {
  const voidedAt = "2041-03-01T09:30:00.000Z";
  harness.setNow(voidedAt);
  const writerToken = await issueAdminToken("admin-void-content-writer");
  const firstVoidToken = await issueAdminToken("admin-void-operator-a", [
    "content:void",
  ]);
  const secondVoidToken = await issueAdminToken("admin-void-operator-b", [
    "content:void",
  ]);
  const revisions = await Promise.all([
    publishRevision(writerToken, "void-a", "easy", "void-alpha"),
    publishRevision(writerToken, "void-b", "easy", "void-alpha"),
    publishRevision(writerToken, "void-c", "medium", "void-beta"),
    publishRevision(writerToken, "void-d", "medium", "void-beta"),
    publishRevision(writerToken, "void-e", "hard", "void-gamma"),
  ]);
  const publishedDraft = await createDailySet(
    writerToken,
    "2041-03-10",
    revisions,
  );
  const publishedResponse = await publishDailySet(
    writerToken,
    publishedDraft.dailySetId,
  );
  assert.equal(publishedResponse.statusCode, 200, publishedResponse.body);
  const draft = await createDailySet(writerToken, "2041-03-11", revisions);

  const writerDenied = await harness.app.inject({
    method: "PUT",
    url: `${ADMIN_CONTENT_URL}/daily-sets/${publishedDraft.dailySetId}/void`,
    headers: authorizationHeaders(writerToken),
    payload: { reason: "잘못된 점수 기준" },
  });
  expectApiError(writerDenied, 403, "ADMIN_FORBIDDEN");

  const draftDenied = await harness.app.inject({
    method: "PUT",
    url: `${ADMIN_CONTENT_URL}/daily-sets/${draft.dailySetId}/void`,
    headers: authorizationHeaders(firstVoidToken),
    payload: { reason: "게시 전 무효 처리 시도" },
  });
  expectApiError(draftDenied, 409, "DAILY_SET_NOT_PUBLISHED");

  const fixture = await harness.database.client.begin(async (transaction) => {
    const users = await transaction<{ id: string }[]>`
      INSERT INTO users (
        anon_key_fingerprint,
        identity_verified_at
      )
      VALUES (
        ${"f".repeat(64)},
        ${voidedAt}
      )
      RETURNING id
    `;
    const userId = users[0]!.id;
    const attempts = await transaction<{ id: string }[]>`
      INSERT INTO attempts (
        user_id,
        daily_set_id,
        status,
        score,
        completed_at
      )
      VALUES (
        ${userId},
        ${publishedDraft.dailySetId},
        'completed',
        3,
        ${voidedAt}
      )
      RETURNING id
    `;
    const challenges = await transaction<{ id: string }[]>`
      INSERT INTO challenges (
        public_token_hash,
        daily_set_id,
        creator_user_id,
        creator_attempt_id,
        creator_score,
        creator_nickname_snapshot,
        status,
        completed_at,
        expires_at,
        result_redacted_at
      )
      VALUES (
        ${"e".repeat(64)},
        ${publishedDraft.dailySetId},
        ${userId},
        ${attempts[0]!.id},
        3,
        '무효테스트',
        'completed',
        ${voidedAt},
        ${"2041-03-04T09:30:00.000Z"},
        ${voidedAt}
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO notification_outbox (
        event_type,
        recipient_user_id,
        challenge_id,
        dedupe_key,
        status,
        available_at,
        occurred_at
      )
      VALUES (
        'challenge.completed',
        ${userId},
        ${challenges[0]!.id},
        ${`challenge.completed:${challenges[0]!.id}`},
        'pending',
        ${voidedAt},
        ${voidedAt}
      )
    `;
    return { challengeId: challenges[0]!.id };
  });

  const reason = "잘못된 점수 기준";
  const raced = await Promise.all([
    harness.app.inject({
      method: "PUT",
      url: `${ADMIN_CONTENT_URL}/daily-sets/${publishedDraft.dailySetId}/void`,
      headers: authorizationHeaders(firstVoidToken),
      payload: { reason: `  ${reason}  ` },
    }),
    harness.app.inject({
      method: "PUT",
      url: `${ADMIN_CONTENT_URL}/daily-sets/${publishedDraft.dailySetId}/void`,
      headers: authorizationHeaders(secondVoidToken),
      payload: { reason },
    }),
  ]);
  assert.ok(
    raced.every((response) => response.statusCode === 200),
    raced.map((response) => response.body).join("\n"),
  );
  const voidResults = raced.map((response) =>
    AdminVoidDailySetResponseSchema.parse(response.json()),
  );
  assert.deepEqual(voidResults.map((result) => result.replayed).sort(), [
    false,
    true,
  ]);
  assert.deepEqual(voidResults[0]!.void, voidResults[1]!.void);
  assert.equal(voidResults[0]!.void.reason, reason);
  assert.equal(voidResults[0]!.void.voidedAt, voidedAt);
  assert.ok(
    ["admin-void-operator-a", "admin-void-operator-b"].includes(
      voidResults[0]!.void.actorSubject,
    ),
  );

  const sameReasonReplay = await harness.app.inject({
    method: "PUT",
    url: `${ADMIN_CONTENT_URL}/daily-sets/${publishedDraft.dailySetId}/void`,
    headers: authorizationHeaders(firstVoidToken),
    payload: { reason },
  });
  assert.equal(sameReasonReplay.statusCode, 200, sameReasonReplay.body);
  const replayed = AdminVoidDailySetResponseSchema.parse(
    sameReasonReplay.json(),
  );
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.void, voidResults[0]!.void);

  const conflictingReason = await harness.app.inject({
    method: "PUT",
    url: `${ADMIN_CONTENT_URL}/daily-sets/${publishedDraft.dailySetId}/void`,
    headers: authorizationHeaders(firstVoidToken),
    payload: { reason: "다른 운영 사유" },
  });
  expectApiError(conflictingReason, 409, "DAILY_SET_ALREADY_VOIDED");

  const persisted = await harness.database.client<
    {
      actor_subject: string;
      reason: string;
      voided_at: Date | string;
      audit_count: number;
      audit_actor: string;
      audit_metadata: unknown;
      outbox_status: string;
      last_error: string | null;
    }[]
  >`
    SELECT
      dsv.actor_subject,
      dsv.reason,
      dsv.voided_at,
      (
        SELECT count(*)::int
        FROM admin_audit_logs aal
        WHERE aal.action = 'daily_set.void'
          AND aal.resource_id = dsv.daily_set_id
      ) AS audit_count,
      (
        SELECT aal.actor_subject
        FROM admin_audit_logs aal
        WHERE aal.action = 'daily_set.void'
          AND aal.resource_id = dsv.daily_set_id
      ) AS audit_actor,
      (
        SELECT aal.metadata
        FROM admin_audit_logs aal
        WHERE aal.action = 'daily_set.void'
          AND aal.resource_id = dsv.daily_set_id
      ) AS audit_metadata,
      no.status::text AS outbox_status,
      no.last_error
    FROM daily_set_voids dsv
    JOIN challenges c ON c.daily_set_id = dsv.daily_set_id
    JOIN notification_outbox no ON no.challenge_id = c.id
    WHERE dsv.daily_set_id = ${publishedDraft.dailySetId}
      AND c.id = ${fixture.challengeId}
  `;
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.actor_subject, voidResults[0]!.void.actorSubject);
  assert.equal(persisted[0]!.reason, reason);
  assert.equal(new Date(persisted[0]!.voided_at).toISOString(), voidedAt);
  assert.equal(persisted[0]!.audit_count, 1);
  assert.equal(persisted[0]!.audit_actor, voidResults[0]!.void.actorSubject);
  assert.deepEqual(persisted[0]!.audit_metadata, {
    action: "daily_set.void",
    reason,
  });
  assert.equal(persisted[0]!.outbox_status, "failed");
  assert.equal(persisted[0]!.last_error, "daily_set_voided");

  const listedResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_CONTENT_URL}/daily-sets?from=2041-03-10&to=2041-03-10&status=published`,
    headers: authorizationHeaders(writerToken),
  });
  assert.equal(listedResponse.statusCode, 200, listedResponse.body);
  const listed = AdminListDailySetsResponseSchema.parse(
    listedResponse.json(),
  ).dailySets;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.void, voidResults[0]!.void);
  assert.equal(listed[0]?.status, "published");
  assert.equal(listed[0]?.items.length, 5);

  await assert.rejects(
    harness.database.client`
      UPDATE daily_set_voids
      SET reason = '변조'
      WHERE daily_set_id = ${publishedDraft.dailySetId}
    `,
    /daily set void records are immutable/,
  );
  await assert.rejects(
    harness.database.client`
      DELETE FROM daily_set_voids
      WHERE daily_set_id = ${publishedDraft.dailySetId}
    `,
    /daily set void records are immutable/,
  );
});
