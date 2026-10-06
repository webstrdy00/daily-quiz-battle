import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  ClaimChallengeResponseSchema,
  CompleteAttemptResponseSchema,
  CreateChallengeResponseSchema,
  DailyStartResponseSchema,
  type CompleteAttemptRequest,
  type CompletedAttemptResponse,
  type DailyAvailableStartResponse,
  type PublicQuestion,
  type SavedAnswer,
} from "@daily-quiz-battle/contracts";
import { decodeJwt } from "jose";
import type postgres from "postgres";
import { buildApp } from "../app.js";
import { startOrResumeAttempt } from "../daily/service.js";
import { createDatabase } from "../db/client.js";
import {
  createIntegrationHarness,
  NEXT_QUIZ_DATE,
  PRIMARY_DAY_NOON,
  PRIMARY_QUIZ_DATE,
  type IntegrationHarness,
} from "./test-harness.js";

interface JsonResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

const correctSelections = [0, 2, 1, 1, 3] as const;
const shuffledQuizDate = "2026-08-31";
const shuffledChoiceOrder = [2, 0, 3, 1] as const;
const retiredSnapshotQuizDate = "2026-09-01";
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

function idempotentHeaders(
  token: string,
  idempotencyKey: string,
): Record<string, string> {
  return {
    ...authorizationHeaders(token),
    "idempotency-key": idempotencyKey,
  };
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

async function startQuiz(token: string): Promise<DailyAvailableStartResponse> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(token),
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  const start = DailyStartResponseSchema.parse(response.json());
  if (start.status !== "available") {
    assert.fail("daily set must be available in this fixture");
  }
  return start;
}

function answerPayload(
  question: PublicQuestion,
  selectedIndex: number,
): SavedAnswer {
  return {
    sequence: question.sequence,
    questionRevisionId: question.revisionId,
    selectedIndex,
  };
}

async function seedHistoricalAnswer(
  attemptId: string,
  question: PublicQuestion,
  selectedIndex: number,
) {
  await harness.database.client`
    INSERT INTO attempt_answers (attempt_id, sequence, question_revision_id, selected_index)
    VALUES (${attemptId}, ${question.sequence}, ${question.revisionId}, ${selectedIndex})
  `;
}

function batch(
  start: DailyAvailableStartResponse,
  selections: readonly number[] = correctSelections,
): CompleteAttemptRequest {
  return {
    answers: start.questions.map((question, index) =>
      answerPayload(question, selections[index]!),
    ),
  };
}

async function completeQuiz(
  token: string,
  start: DailyAvailableStartResponse,
  idempotencyKey: string,
  payload: CompleteAttemptRequest = batch(start),
) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${start.attempt.id}/complete`,
    headers: idempotentHeaders(token, idempotencyKey),
    payload,
  });
}

async function seedHistoricalAnswers(
  start: DailyAvailableStartResponse,
  count = 5,
): Promise<void> {
  for (const [index, question] of start.questions.slice(0, count).entries()) {
    await seedHistoricalAnswer(
      start.attempt.id,
      question,
      correctSelections[index]!,
    );
  }
}

function parseCompletedAttempt(value: unknown): CompletedAttemptResponse {
  const result = CompleteAttemptResponseSchema.parse(value);
  if (result.status !== "completed") {
    assert.fail("attempt must be completed in this fixture");
  }
  return result;
}

function getTokenUserId(token: string): string {
  const userId = decodeJwt(token).sub;
  assert.ok(userId, "issued access token must contain a subject");
  return userId;
}

async function expectDatabaseFailure(
  action: (transaction: postgres.TransactionSql) => Promise<void>,
  expectedMessage: RegExp,
): Promise<void> {
  const unexpectedCommit = new Error(
    "database mutation unexpectedly succeeded",
  );
  try {
    await harness.database.client.begin(async (transaction) => {
      await action(transaction);
      throw unexpectedCommit;
    });
    assert.fail("database mutation unexpectedly succeeded");
  } catch (error) {
    if (error === unexpectedCommit) {
      assert.fail(unexpectedCommit.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, expectedMessage);
  }
}

test("isolated database setup is migrated, seeded, and ready", async () => {
  const ready = await harness.app.inject({
    method: "GET",
    url: "/health/ready",
  });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.deepEqual(ready.json(), { status: "ready" });
  assert.equal(ready.headers["cache-control"], "no-store");

  const migrations = await harness.database.client<
    { filename: string; applied_count: number }[]
  >`
    SELECT filename, count(*)::int AS applied_count
    FROM app_migrations
    GROUP BY filename
    ORDER BY filename
  `;
  assert.deepEqual(
    migrations.map((row) => [row.filename, row.applied_count]),
    [
      ["0001_initial.sql", 1],
      ["0002_strengthen_immutability.sql", 1],
      ["0003_lock_daily_set_lifecycle.sql", 1],
      ["0004_challenges.sql", 1],
      ["0005_validate_choice_order.sql", 1],
      ["0006_reports.sql", 1],
      ["0007_content_operations.sql", 1],
      ["0008_user_deletion.sql", 1],
      ["0009_notifications.sql", 1],
      ["0010_allow_account_answer_deletion.sql", 1],
      ["0011_harden_content_invariants.sql", 1],
      ["0012_attempt_challenge_provenance.sql", 1],
      ["0013_decouple_report_challenge_retention.sql", 1],
      ["0014_daily_set_voids.sql", 1],
      ["0015_operation_task_runs.sql", 1],
      ["0016_question_report_triage.sql", 1],
      ["0017_fix_report_triage_trigger.sql", 1],
      ["0018_future_daily_set_correction.sql", 1],
    ],
  );

  const dailySets = await harness.database.client<
    {
      quiz_date: string;
      status: string;
      item_count: number;
      distinct_revisions: number;
    }[]
  >`
    SELECT
      ds.quiz_date::text AS quiz_date,
      ds.status::text AS status,
      count(dsi.position)::int AS item_count,
      count(DISTINCT dsi.question_revision_id)::int AS distinct_revisions
    FROM daily_sets ds
    LEFT JOIN daily_set_items dsi ON dsi.daily_set_id = ds.id
    GROUP BY ds.id
    ORDER BY ds.quiz_date
  `;
  assert.deepEqual(
    [...dailySets],
    [
      {
        quiz_date: PRIMARY_QUIZ_DATE,
        status: "published",
        item_count: 5,
        distinct_revisions: 5,
      },
      {
        quiz_date: NEXT_QUIZ_DATE,
        status: "published",
        item_count: 5,
        distinct_revisions: 5,
      },
    ],
  );

  const revisionCount = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM question_revisions
    WHERE lifecycle_status = 'published'
  `;
  assert.equal(revisionCount[0]?.count, 5);
});

test("bootstrap assigns an allowed anonymous nickname and preserves it on replay", async () => {
  const anonymousKey = "dev-it-anonymous-nickname";
  const firstResponse = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  const first = BootstrapResponseSchema.parse(firstResponse.json());
  assert.match(
    first.user.nickname,
    /^(차분한|느긋한|다정한|명랑한)(토끼|수달|참새|고양이)[1-9][0-9]{3}$/,
  );
  assert.ok(first.user.nickname.length <= 12);

  const replayResponse = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(replayResponse.statusCode, 200, replayResponse.body);
  const replay = BootstrapResponseSchema.parse(replayResponse.json());
  assert.equal(replay.user.nickname, first.user.nickname);
  const userId = getTokenUserId(first.accessToken);
  assert.equal(first.user.id, userId);
  assert.equal(replay.user.id, userId);
  assert.equal(getTokenUserId(replay.accessToken), userId);
  const rows = await harness.database.client<{ nickname: string }[]>`
    SELECT nickname FROM users WHERE id = ${userId}
  `;
  assert.equal(rows[0]?.nickname, first.user.nickname);
});

test("bootstrap preserves a pre-existing nickname without backfilling it", async () => {
  const anonymousKey = "dev-it-existing-nickname";
  const userId = getTokenUserId(await bootstrapUser(anonymousKey));
  await harness.database.client`
    UPDATE users SET nickname = '익명 도전자' WHERE id = ${userId}
  `;

  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(response.statusCode, 200, response.body);
  const replay = BootstrapResponseSchema.parse(response.json());
  assert.equal(getTokenUserId(replay.accessToken), userId);
  assert.equal(replay.user.nickname, "익명 도전자");
  const rows = await harness.database.client<{ nickname: string }[]>`
    SELECT nickname FROM users WHERE id = ${userId}
  `;
  assert.equal(rows[0]?.nickname, "익명 도전자");
});

test("concurrent bootstrap requests return the same user and stored nickname", async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      harness.app.inject({
        method: "POST",
        url: "/v1/auth/bootstrap",
        payload: { anonymousKey: "dev-it-concurrent-nickname" },
      }),
    ),
  );
  const bootstraps = responses.map((response) => {
    assert.equal(response.statusCode, 200, response.body);
    return BootstrapResponseSchema.parse(response.json());
  });
  const first = bootstraps[0]!;
  const userId = getTokenUserId(first.accessToken);
  for (const bootstrap of bootstraps) {
    assert.equal(getTokenUserId(bootstrap.accessToken), userId);
    assert.equal(bootstrap.user.nickname, first.user.nickname);
  }
  const rows = await harness.database.client<{ nickname: string }[]>`
    SELECT nickname FROM users WHERE id = ${userId}
  `;
  assert.equal(rows[0]?.nickname, first.user.nickname);
});

test("daily write kill switches separate new starts from attempt draining", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const blockedStartToken = await bootstrapUser("dev-it-daily-start-disabled");
  const drainToken = await bootstrapUser("dev-it-daily-start-drain");
  const drainStart = await startQuiz(drainToken);

  const readWriteRowCounts = async () => {
    const rows = await harness.database.client<
      {
        attempt_count: number;
        answer_count: number;
        idempotency_count: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM attempts) AS attempt_count,
        (SELECT count(*)::int FROM attempt_answers) AS answer_count,
        (SELECT count(*)::int FROM idempotency_records) AS idempotency_count
    `;
    return rows[0]!;
  };
  const expectDisabled = (response: JsonResponse): void => {
    expectApiError(response, 503, "FEATURE_DISABLED");
    assert.equal(ApiErrorSchema.parse(response.json()).retryable, true);
  };
  const assertNoWrites = async (
    expected: Awaited<ReturnType<typeof readWriteRowCounts>>,
  ): Promise<void> => {
    assert.deepEqual(await readWriteRowCounts(), expected);
  };

  const startDisabledConfig = {
    ...harness.config,
    dailyStartEnabled: false,
  };
  const startDisabledDatabase = createDatabase(startDisabledConfig);
  let startDisabledApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    startDisabledApp = await buildApp({
      config: startDisabledConfig,
      database: startDisabledDatabase,
      clock: () => new Date(PRIMARY_DAY_NOON),
    });
    const countsBeforeBlockedStarts = await readWriteRowCounts();

    const unauthenticatedStart = await startDisabledApp.inject({
      method: "POST",
      url: "/v1/daily/start",
      payload: {},
    });
    expectApiError(unauthenticatedStart, 401, "UNAUTHORIZED");
    await assertNoWrites(countsBeforeBlockedStarts);

    const disabledStart = await startDisabledApp.inject({
      method: "POST",
      url: "/v1/daily/start",
      headers: authorizationHeaders(blockedStartToken),
      payload: {},
    });
    expectDisabled(disabledStart);
    await assertNoWrites(countsBeforeBlockedStarts);

    const completed = await startDisabledApp.inject({
      method: "POST",
      url: `/v1/attempts/${drainStart.attempt.id}/complete`,
      headers: idempotentHeaders(
        drainToken,
        "daily-start-disabled-drain-complete",
      ),
      payload: batch(drainStart),
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(parseCompletedAttempt(completed.json()).score, 5);
    assert.deepEqual(await readWriteRowCounts(), {
      attempt_count: countsBeforeBlockedStarts.attempt_count,
      answer_count: countsBeforeBlockedStarts.answer_count + 5,
      idempotency_count: countsBeforeBlockedStarts.idempotency_count + 1,
    });
  } finally {
    if (startDisabledApp !== undefined) {
      await startDisabledApp.close();
    } else {
      await startDisabledDatabase.close();
    }
  }

  const continuationToken = await bootstrapUser(
    "dev-it-daily-continuation-disabled",
  );
  const continuationDisabledConfig = {
    ...harness.config,
    dailyContinuationEnabled: false,
  };
  const continuationDisabledDatabase = createDatabase(
    continuationDisabledConfig,
  );
  let continuationDisabledApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    continuationDisabledApp = await buildApp({
      config: continuationDisabledConfig,
      database: continuationDisabledDatabase,
      clock: () => new Date(PRIMARY_DAY_NOON),
    });
    const countsBeforeAllowedStart = await readWriteRowCounts();
    const allowedStartResponse = await continuationDisabledApp.inject({
      method: "POST",
      url: "/v1/daily/start",
      headers: authorizationHeaders(continuationToken),
      payload: {},
    });
    assert.equal(
      allowedStartResponse.statusCode,
      200,
      allowedStartResponse.body,
    );
    const allowedStart = DailyStartResponseSchema.parse(
      allowedStartResponse.json(),
    );
    if (allowedStart.status !== "available") {
      assert.fail("daily set must be available in this fixture");
    }
    const countsBeforeBlockedContinuations = await readWriteRowCounts();
    assert.deepEqual(countsBeforeBlockedContinuations, {
      attempt_count: countsBeforeAllowedStart.attempt_count + 1,
      answer_count: countsBeforeAllowedStart.answer_count,
      idempotency_count: countsBeforeAllowedStart.idempotency_count,
    });

    const unauthenticatedComplete = await continuationDisabledApp.inject({
      method: "POST",
      url: `/v1/attempts/${allowedStart.attempt.id}/complete`,
      headers: {
        "idempotency-key": "daily-continuation-disabled-unauth-complete",
      },
      payload: batch(allowedStart),
    });
    expectApiError(unauthenticatedComplete, 401, "UNAUTHORIZED");
    await assertNoWrites(countsBeforeBlockedContinuations);

    const disabledComplete = await continuationDisabledApp.inject({
      method: "POST",
      url: `/v1/attempts/${allowedStart.attempt.id}/complete`,
      headers: idempotentHeaders(
        continuationToken,
        "daily-continuation-disabled-complete",
      ),
      payload: batch(allowedStart),
    });
    expectDisabled(disabledComplete);
    await assertNoWrites(countsBeforeBlockedContinuations);
  } finally {
    if (continuationDisabledApp !== undefined) {
      await continuationDisabledApp.close();
    } else {
      await continuationDisabledDatabase.close();
    }
  }
});

test("full daily flow resumes and replays without exposing answers early", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-happy-path");
  const start = await startQuiz(token);
  const resumed = await startQuiz(token);

  assert.equal(start.attempt.quizDate, PRIMARY_QUIZ_DATE);
  assert.equal(start.attempt.status, "started");
  assert.equal(start.questions.length, 5);
  assert.equal(resumed.attempt.id, start.attempt.id);
  assert.equal(resumed.attempt.answeredCount, 0);
  assert.equal("completedResult" in start, false);
  assert.equal("completedResult" in resumed, false);
  for (const question of start.questions) {
    assert.equal("correctIndex" in question, false);
    assert.equal("explanation" in question, false);
  }

  const completed = await completeQuiz(token, start, "happy-complete-1");
  const completedReplay = await completeQuiz(token, start, "happy-complete-1", {
    answers: [...batch(start).answers].reverse(),
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completedReplay.statusCode, 200, completedReplay.body);
  const result = parseCompletedAttempt(completed.json());
  assert.deepEqual(parseCompletedAttempt(completedReplay.json()), result);
  assert.equal(result.score, 5);
  assert.equal(result.review.length, 5);
  assert.ok(result.review.every((item) => item.correct));
  const changedBatch = batch(start, [1, 2, 1, 1, 3]);
  expectApiError(
    await completeQuiz(token, start, "happy-complete-1", changedBatch),
    409,
    "IDEMPOTENCY_KEY_REUSED",
  );
  expectApiError(
    await completeQuiz(token, start, "happy-changed-new-key", changedBatch),
    409,
    "ATTEMPT_ALREADY_COMPLETED",
  );
  const recovered = await completeQuiz(token, start, "happy-recovery-new-key");
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.deepEqual(parseCompletedAttempt(recovered.json()), result);
  const oldAnswer = await harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${start.attempt.id}/answers`,
    headers: idempotentHeaders(token, "removed-answer-route"),
    payload: answerPayload(start.questions[0]!, 0),
  });
  expectApiError(oldAnswer, 404, "NOT_FOUND");

  const recordsBeforeResume = await harness.database.client`
    SELECT *
    FROM idempotency_records
    WHERE user_id = ${getTokenUserId(token)}
    ORDER BY id
  `;
  const completedResume = await startQuiz(token);
  assert.equal(completedResume.attempt.id, start.attempt.id);
  assert.equal(completedResume.attempt.status, "completed");
  assert.equal(completedResume.attempt.answeredCount, 5);
  assert.equal(completedResume.attempt.score, 5);
  assert.deepEqual(completedResume.completedResult, result);
  const recordsAfterResume = await harness.database.client`
    SELECT *
    FROM idempotency_records
    WHERE user_id = ${getTokenUserId(token)}
    ORDER BY id
  `;
  assert.deepEqual([...recordsAfterResume], [...recordsBeforeResume]);

  const rows = await harness.database.client<
    {
      status: string;
      score: number;
      answer_count: number;
      streak_days: number;
      last_daily_date: string;
    }[]
  >`
    SELECT
      a.status::text AS status,
      a.score::int AS score,
      count(aa.id)::int AS answer_count,
      u.streak_days::int AS streak_days,
      u.last_daily_date::text AS last_daily_date
    FROM attempts a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN attempt_answers aa ON aa.attempt_id = a.id
    WHERE a.id = ${start.attempt.id}
    GROUP BY a.id, u.id
  `;
  assert.deepEqual(rows[0], {
    status: "completed",
    score: 5,
    answer_count: 5,
    streak_days: 1,
    last_daily_date: PRIMARY_QUIZ_DATE,
  });

  const idempotency = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM idempotency_records
    WHERE resource_id = ${start.attempt.id}
      AND status = 'completed'
      AND response_status = 200
  `;
  assert.equal(idempotency[0]?.count, 2);
});

test("retired revisions block new starts without invalidating an existing attempt snapshot", async () => {
  const dailySets = await harness.database.client<{ id: string }[]>`
    INSERT INTO daily_sets (quiz_date, status)
    VALUES (${retiredSnapshotQuizDate}, 'draft')
    RETURNING id
  `;
  const dailySetId = dailySets[0]!.id;
  const revisionIds: string[] = [];

  for (let position = 1; position <= 5; position += 1) {
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
      SELECT
        ${questions[0]!.id},
        1,
        qr.category,
        qr.difficulty,
        qr.prompt,
        qr.choices,
        qr.correct_index,
        qr.explanation,
        qr.source_url,
        qr.source_checked_at,
        'retired-snapshot-fixture',
        'published',
        now()
      FROM daily_set_items dsi
      JOIN daily_sets ds ON ds.id = dsi.daily_set_id
      JOIN question_revisions qr ON qr.id = dsi.question_revision_id
      WHERE ds.quiz_date = ${PRIMARY_QUIZ_DATE}
        AND dsi.position = ${position}
      RETURNING id
    `;
    const revisionId = revisions[0]!.id;
    revisionIds.push(revisionId);
    await harness.database.client`
      INSERT INTO daily_set_items (
        daily_set_id,
        position,
        question_revision_id,
        choice_order
      )
      VALUES (
        ${dailySetId},
        ${position},
        ${revisionId},
        '[0, 1, 2, 3]'::jsonb
      )
    `;
  }

  await harness.database.client`
    UPDATE daily_sets
    SET status = 'published', published_at = now()
    WHERE id = ${dailySetId}
  `;

  harness.setNow("2026-09-01T03:00:00.000Z");
  const existingUserToken = await bootstrapUser(
    "dev-it-retired-snapshot-existing",
  );
  const started = await startQuiz(existingUserToken);
  await seedHistoricalAnswer(
    started.attempt.id,
    started.questions[0]!,
    correctSelections[0],
  );

  await harness.database.client`
    UPDATE question_revisions
    SET lifecycle_status = 'retired', retired_at = now()
    WHERE id = ${revisionIds[0]!}
  `;

  const resumed = await startQuiz(existingUserToken);
  assert.equal(resumed.attempt.id, started.attempt.id);
  assert.equal(resumed.attempt.status, "started");
  assert.equal(resumed.attempt.answeredCount, 1);
  assert.equal("completedResult" in resumed, false);
  assert.deepEqual(resumed.questions, started.questions);

  const newUserToken = await bootstrapUser("dev-it-retired-snapshot-new");
  const blockedStart = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(newUserToken),
    payload: {},
  });
  expectApiError(blockedStart, 503, "DAILY_SET_NOT_READY");

  const completed = await completeQuiz(
    existingUserToken,
    resumed,
    "retired-snapshot-complete",
  );
  const completedReplay = await completeQuiz(
    existingUserToken,
    resumed,
    "retired-snapshot-complete",
  );
  const completedRecovery = await completeQuiz(
    existingUserToken,
    resumed,
    "retired-snapshot-result-recovery",
  );
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completedReplay.statusCode, 200, completedReplay.body);
  assert.equal(completedRecovery.statusCode, 200, completedRecovery.body);
  const completedResult = parseCompletedAttempt(completed.json());
  assert.deepEqual(
    parseCompletedAttempt(completedReplay.json()),
    completedResult,
  );
  assert.deepEqual(
    parseCompletedAttempt(completedRecovery.json()),
    completedResult,
  );

  const completedResume = await startQuiz(existingUserToken);
  assert.equal(completedResume.attempt.id, started.attempt.id);
  assert.equal(completedResume.attempt.status, "completed");
  assert.equal(completedResume.attempt.score, 5);
  assert.deepEqual(completedResume.questions, started.questions);
  assert.deepEqual(completedResume.completedResult, completedResult);
});

test("completion scores and reviews answers in displayed choice order", async () => {
  const dailySets = await harness.database.client<{ id: string }[]>`
    INSERT INTO daily_sets (quiz_date, status)
    VALUES (${shuffledQuizDate}, 'draft')
    RETURNING id
  `;
  const dailySetId = dailySets[0]!.id;

  await harness.database.client`
    INSERT INTO daily_set_items (
      daily_set_id,
      position,
      question_revision_id,
      choice_order
    )
    SELECT
      ${dailySetId},
      dsi.position,
      dsi.question_revision_id,
      '[2, 0, 3, 1]'::jsonb
    FROM daily_set_items dsi
    JOIN daily_sets ds ON ds.id = dsi.daily_set_id
    WHERE ds.quiz_date = ${PRIMARY_QUIZ_DATE}
    ORDER BY dsi.position
  `;
  await harness.database.client`
    UPDATE daily_sets
    SET status = 'published', published_at = now()
    WHERE id = ${dailySetId}
  `;

  harness.setNow("2026-08-31T03:00:00.000Z");
  const token = await bootstrapUser("dev-it-shuffled-choice-order");
  const start = await startQuiz(token);
  const displayedCorrectSelections = correctSelections.map((correctIndex) =>
    shuffledChoiceOrder.indexOf(correctIndex),
  );

  assert.equal(start.attempt.quizDate, shuffledQuizDate);
  assert.deepEqual(start.questions[0]?.choices, ["O₂", "H₂O", "NaCl", "CO₂"]);

  const completed = await completeQuiz(
    token,
    start,
    "shuffled-complete-1",
    batch(start, displayedCorrectSelections),
  );
  assert.equal(completed.statusCode, 200, completed.body);
  const result = parseCompletedAttempt(completed.json());

  assert.equal(result.score, 5);
  assert.deepEqual(
    result.review.map((item) => item.selectedIndex),
    displayedCorrectSelections,
  );
  assert.deepEqual(
    result.review.map((item) => item.correctIndex),
    displayedCorrectSelections,
  );
  assert.ok(result.review.every((item) => item.correct));
  const resumed = await startQuiz(token);
  assert.deepEqual(resumed.completedResult, result);
  assert.deepEqual(resumed.questions, start.questions);
});

test("late historical challenge completion does not regress daily streak state", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-monotonic-daily-state");
  const userId = getTokenUserId(token);

  const creatorToken = await bootstrapUser(
    "dev-it-monotonic-challenge-creator",
  );
  const creator = await startQuiz(creatorToken);
  const creatorCompleted = await completeQuiz(
    creatorToken,
    creator,
    "monotonic-creator-complete",
  );
  assert.equal(creatorCompleted.statusCode, 200, creatorCompleted.body);

  const challengeCreatedResponse = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(
      creatorToken,
      "monotonic-historical-challenge-create",
    ),
    payload: { attemptId: creator.attempt.id },
  });
  assert.equal(
    challengeCreatedResponse.statusCode,
    200,
    challengeCreatedResponse.body,
  );
  const challengeCreated = CreateChallengeResponseSchema.parse(
    challengeCreatedResponse.json(),
  );

  harness.setNow("2026-08-30T03:00:00.000Z");
  const claimedResponse = await harness.app.inject({
    method: "POST",
    url: `/v1/challenges/${challengeCreated.challenge.token}/claim`,
    headers: idempotentHeaders(token, "monotonic-historical-claim"),
    payload: {},
  });
  assert.equal(claimedResponse.statusCode, 200, claimedResponse.body);
  const historical = ClaimChallengeResponseSchema.parse(
    claimedResponse.json(),
  ).daily;
  assert.equal(historical.attempt.quizDate, PRIMARY_QUIZ_DATE);
  assert.equal(historical.attempt.status, "started");
  const historicalRows = await harness.database.client<
    { daily_set_id: string; challenge_id: string | null }[]
  >`
    SELECT daily_set_id, challenge_id
    FROM attempts
    WHERE id = ${historical.attempt.id}
  `;
  assert.ok(historicalRows[0]!.challenge_id);
  const historicalResume = await harness.database.client.begin((transaction) =>
    startOrResumeAttempt(transaction, {
      userId,
      now: new Date("2026-08-30T03:00:00.000Z"),
      setFilter: { dailySetId: historicalRows[0]!.daily_set_id },
    }),
  );
  assert.deepEqual(historicalResume, historical);
  const current = await startQuiz(token);
  assert.equal(current.attempt.quizDate, NEXT_QUIZ_DATE);
  const currentCompleted = await completeQuiz(
    token,
    current,
    "monotonic-current-complete",
  );
  assert.equal(currentCompleted.statusCode, 200, currentCompleted.body);

  const stateBeforeHistoricalCompletion = await harness.database.client<
    { streak_days: number; last_daily_date: string }[]
  >`
    SELECT
      streak_days::int AS streak_days,
      last_daily_date::text AS last_daily_date
    FROM users
    WHERE id = ${userId}
  `;
  assert.deepEqual(stateBeforeHistoricalCompletion[0], {
    streak_days: 1,
    last_daily_date: NEXT_QUIZ_DATE,
  });

  const historicalCompleted = await completeQuiz(
    token,
    historical,
    "monotonic-historical-complete",
  );
  assert.equal(historicalCompleted.statusCode, 200, historicalCompleted.body);

  const stateAfterHistoricalCompletion = await harness.database.client<
    { streak_days: number; last_daily_date: string }[]
  >`
    SELECT
      streak_days::int AS streak_days,
      last_daily_date::text AS last_daily_date
    FROM users
    WHERE id = ${userId}
  `;
  assert.deepEqual(
    stateAfterHistoricalCompletion[0],
    stateBeforeHistoricalCompletion[0],
  );
});

test("authentication, ownership, and invalid fifth revision roll back the entire batch", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const unauthenticated = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    payload: {},
  });
  expectApiError(unauthenticated, 401, "UNAUTHORIZED");

  const invalidToken = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders("invalid-token"),
    payload: {},
  });
  expectApiError(invalidToken, 401, "UNAUTHORIZED");

  const ownerToken = await bootstrapUser("dev-it-owner");
  const intruderToken = await bootstrapUser("dev-it-intruder");
  const start = await startQuiz(ownerToken);

  const forbiddenComplete = await completeQuiz(
    intruderToken,
    start,
    "owner-complete-forbidden",
  );
  expectApiError(forbiddenComplete, 403, "FORBIDDEN");

  const invalidBatch = batch(start);
  invalidBatch.answers[4]!.questionRevisionId = start.questions[0]!.revisionId;
  const wrongRevision = await completeQuiz(
    ownerToken,
    start,
    "rollback-complete-1",
    invalidBatch,
  );
  expectApiError(wrongRevision, 409, "QUESTION_REVISION_CONFLICT");
  const rollbackState = await harness.database.client`
    SELECT a.status::text AS status, a.score, a.completed_at,
      u.streak_days,
      (SELECT count(*)::int FROM attempt_answers WHERE attempt_id = a.id) AS answer_count,
      (SELECT count(*)::int FROM idempotency_records WHERE user_id = u.id) AS idempotency_count
    FROM attempts a JOIN users u ON u.id = a.user_id
    WHERE a.id = ${start.attempt.id}
  `;
  assert.deepEqual(rollbackState[0], {
    status: "started",
    score: null,
    completed_at: null,
    streak_days: 0,
    answer_count: 0,
    idempotency_count: 0,
  });

  const completed = await completeQuiz(
    ownerToken,
    start,
    "rollback-complete-1",
  );
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(parseCompletedAttempt(completed.json()).score, 5);
  expectApiError(
    await completeQuiz(intruderToken, start, "rollback-complete-1"),
    403,
    "FORBIDDEN",
  );
  const answerCount = await harness.database.client`
    SELECT count(*)::int AS count FROM attempt_answers WHERE attempt_id = ${start.attempt.id}
  `;
  assert.equal(answerCount[0]?.count, 5);

  const processingRecords = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM idempotency_records
    WHERE status = 'processing'
  `;
  assert.equal(processingRecords[0]?.count, 0);

  const invalidatedToken = await bootstrapUser("dev-it-token-version");
  const invalidatedUserId = getTokenUserId(invalidatedToken);
  await harness.database.client`
    UPDATE users
    SET token_version = token_version + 1
    WHERE id = ${invalidatedUserId}
  `;
  const invalidatedRequest = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(invalidatedToken),
    payload: {},
  });
  expectApiError(invalidatedRequest, 401, "UNAUTHORIZED");
});

test("batch validation requires exactly five unique valid answers and leaves no writes", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-answer-error-precedence");
  const start = await startQuiz(token);
  const answers = batch(start).answers;
  for (const payload of [
    {},
    { answers: answers.slice(0, 4) },
    { answers: [...answers, answers[0]] },
    { answers: [...answers.slice(0, 4), answers[0]] },
    {
      answers: answers.map((answer, index) =>
        index === 4 ? { ...answer, sequence: 6 } : answer,
      ),
    },
    {
      answers: answers.map((answer, index) =>
        index === 4 ? { ...answer, selectedIndex: 4 } : answer,
      ),
    },
    {
      answers: answers.map((answer, index) =>
        index === 4 ? { ...answer, selectedIndex: -1 } : answer,
      ),
    },
    {
      answers: answers.map((answer, index) =>
        index === 4 ? { ...answer, questionRevisionId: "invalid" } : answer,
      ),
    },
    {
      answers: answers.map((answer, index) =>
        index === 4 ? { ...answer, extra: true } : answer,
      ),
    },
  ]) {
    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/attempts/${start.attempt.id}/complete`,
      headers: idempotentHeaders(token, "validation-reusable-key"),
      payload,
    });
    expectApiError(response, 400, "INVALID_REQUEST");
  }

  const resumed = await startQuiz(token);
  assert.equal(resumed.attempt.answeredCount, 0);
  const records = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM idempotency_records
    WHERE user_id = ${getTokenUserId(token)}
      AND operation = ${`batch-complete:${start.attempt.id}`}
  `;
  assert.equal(records[0]?.count, 0);
  const completed = await completeQuiz(token, start, "validation-reusable-key");
  assert.equal(completed.statusCode, 200, completed.body);
});

test("concurrent starts and identical batch completions converge", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-concurrency");
  const starts = await Promise.all(
    Array.from({ length: 8 }, () => startQuiz(token)),
  );
  const attemptIds = new Set(starts.map((value) => value.attempt.id));
  assert.equal(attemptIds.size, 1);
  const start = starts[0]!;
  const userId = getTokenUserId(token);

  const completes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      completeQuiz(token, start, `concurrent-complete-${index + 1}`),
    ),
  );
  assert.ok(
    completes.every((response) => response.statusCode === 200),
    completes.map((response) => response.body).join("\n"),
  );
  const firstComplete = parseCompletedAttempt(completes[0]!.json());
  for (const response of completes.slice(1)) {
    assert.deepEqual(parseCompletedAttempt(response.json()), firstComplete);
  }

  const state = await harness.database.client<
    {
      attempt_count: number;
      answer_count: number;
      streak_days: number;
      score: number;
      answer_idempotency_count: number;
      complete_idempotency_count: number;
      processing_idempotency_count: number;
    }[]
  >`
    SELECT
      count(DISTINCT a.id)::int AS attempt_count,
      count(aa.id)::int AS answer_count,
      u.streak_days::int AS streak_days,
      max(a.score)::int AS score,
      (
        SELECT count(*)::int
        FROM idempotency_records ir
        WHERE ir.user_id = u.id
          AND ir.operation = ${`answer:${start.attempt.id}`}
          AND ir.status = 'completed'
          AND ir.response_status = 200
      ) AS answer_idempotency_count,
      (
        SELECT count(*)::int
        FROM idempotency_records ir
        WHERE ir.user_id = u.id
          AND ir.operation = ${`batch-complete:${start.attempt.id}`}
          AND ir.status = 'completed'
          AND ir.response_status = 200
      ) AS complete_idempotency_count,
      (
        SELECT count(*)::int
        FROM idempotency_records ir
        WHERE ir.user_id = u.id
          AND ir.status = 'processing'
      ) AS processing_idempotency_count
    FROM users u
    JOIN attempts a ON a.user_id = u.id
    LEFT JOIN attempt_answers aa ON aa.attempt_id = a.id
    WHERE u.id = ${userId}
    GROUP BY u.id
  `;
  assert.deepEqual(state[0], {
    attempt_count: 1,
    answer_count: 5,
    streak_days: 1,
    score: 5,
    answer_idempotency_count: 0,
    complete_idempotency_count: 8,
    processing_idempotency_count: 0,
  });
});

test("historical partial answers must match and remain immutable during batch completion", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  for (const count of [1, 2, 3, 4, 5]) {
    const token = await bootstrapUser(`dev-it-historical-partial-${count}`);
    const start = await startQuiz(token);
    await seedHistoricalAnswers(start, count);
    const before = await harness.database.client`
      SELECT * FROM attempt_answers WHERE attempt_id = ${start.attempt.id} ORDER BY sequence
    `;
    const resumed = await startQuiz(token);
    assert.equal(resumed.attempt.answeredCount, count);
    assert.equal("completedResult" in resumed, false);
    assert.deepEqual(
      resumed.attempt.answers,
      batch(start).answers.slice(0, count),
    );
    const mismatch = await completeQuiz(
      token,
      start,
      `partial-complete-${count}`,
      batch(start, [1, 2, 1, 1, 3]),
    );
    expectApiError(mismatch, 409, "SAVED_ANSWER_CONFLICT");
    const afterFailure = await harness.database.client`
      SELECT * FROM attempt_answers WHERE attempt_id = ${start.attempt.id} ORDER BY sequence
    `;
    assert.deepEqual([...afterFailure], [...before]);
    const records = await harness.database.client`
      SELECT count(*)::int AS count FROM idempotency_records WHERE user_id = ${getTokenUserId(token)}
    `;
    assert.equal(records[0]?.count, 0);
    const completed = await completeQuiz(
      token,
      start,
      `partial-complete-${count}`,
    );
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(parseCompletedAttempt(completed.json()).score, 5);
    const after = await harness.database.client`
      SELECT * FROM attempt_answers WHERE attempt_id = ${start.attempt.id} ORDER BY sequence
    `;
    assert.equal(after.length, 5);
    assert.deepEqual([...after].slice(0, count), [...before]);
  }
});

test("concurrent changed batches cannot overwrite the winner or split its answers", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  for (const sameKey of [false, true]) {
    const token = await bootstrapUser(`dev-it-changed-batch-race-${sameKey}`);
    const start = await startQuiz(token);
    const requests = [batch(start), batch(start, [1, 3, 2, 2, 0])];
    const responses = await Promise.all(
      requests.map((request, index) =>
        completeQuiz(
          token,
          start,
          sameKey ? "race-shared" : `race-distinct-${index}`,
          request,
        ),
      ),
    );
    const winner = responses.findIndex(
      (response) => response.statusCode === 200,
    );
    assert.notEqual(winner, -1);
    const loser = 1 - winner;
    expectApiError(
      responses[loser]!,
      409,
      sameKey ? "IDEMPOTENCY_KEY_REUSED" : "ATTEMPT_ALREADY_COMPLETED",
    );
    const result = parseCompletedAttempt(responses[winner]!.json());
    assert.deepEqual(
      result.review.map((answer) => answer.selectedIndex),
      requests[winner]!.answers.map((answer) => answer.selectedIndex),
    );
    const rows = await harness.database.client`
      SELECT sequence, question_revision_id AS "questionRevisionId", selected_index AS "selectedIndex"
      FROM attempt_answers WHERE attempt_id = ${start.attempt.id} ORDER BY sequence
    `;
    assert.deepEqual([...rows], requests[winner]!.answers);
    const state = await harness.database.client`
      SELECT u.streak_days,
        (SELECT count(*)::int FROM idempotency_records WHERE user_id = u.id) AS records,
        (SELECT count(*)::int FROM idempotency_records WHERE user_id = u.id AND status = 'processing') AS processing
      FROM users u WHERE u.id = ${getTokenUserId(token)}
    `;
    assert.deepEqual(state[0], { streak_days: 1, records: 1, processing: 0 });
  }
});

test("KST date selection and 01:00 grace deadline are deterministic", async () => {
  try {
    harness.setNow("2026-08-29T14:59:00.000Z");
    const beforeMidnightToken = await bootstrapUser("dev-it-before-midnight");
    const beforeMidnight = await startQuiz(beforeMidnightToken);
    assert.equal(beforeMidnight.attempt.quizDate, PRIMARY_QUIZ_DATE);

    harness.setNow("2026-08-29T15:00:00.000Z");
    const afterMidnightToken = await bootstrapUser("dev-it-after-midnight");
    const afterMidnight = await startQuiz(afterMidnightToken);
    assert.equal(afterMidnight.attempt.quizDate, NEXT_QUIZ_DATE);
    assert.notEqual(afterMidnight.attempt.id, beforeMidnight.attempt.id);

    harness.setNow("2026-08-29T15:59:59.999Z");
    const graceComplete = await completeQuiz(
      beforeMidnightToken,
      beforeMidnight,
      "grace-complete-1",
    );
    assert.equal(graceComplete.statusCode, 200, graceComplete.body);

    harness.setNow("2026-08-29T14:59:00.000Z");
    const expiredAnswerToken = await bootstrapUser("dev-it-expired-answer");
    const expiredAnswerStart = await startQuiz(expiredAnswerToken);
    harness.setNow("2026-08-29T16:00:00.000Z");
    const expiredAnswer = await completeQuiz(
      expiredAnswerToken,
      expiredAnswerStart,
      "expired-answer-1",
    );
    expectApiError(expiredAnswer, 409, "ATTEMPT_ABANDONED");

    const expiredAnswerState = await harness.database.client<
      {
        status: string;
        abandoned: boolean;
        answer_count: number;
        idempotency_count: number;
      }[]
    >`
      SELECT
        a.status::text AS status,
        (a.abandoned_at IS NOT NULL) AS abandoned,
        (SELECT count(*)::int FROM attempt_answers WHERE attempt_id = a.id) AS answer_count,
        (
          SELECT count(*)::int
          FROM idempotency_records ir
          WHERE ir.operation = ${`batch-complete:${expiredAnswerStart.attempt.id}`}
        ) AS idempotency_count
      FROM attempts a
      WHERE a.id = ${expiredAnswerStart.attempt.id}
    `;
    assert.deepEqual(expiredAnswerState[0], {
      status: "abandoned",
      abandoned: true,
      answer_count: 0,
      idempotency_count: 0,
    });

    harness.setNow("2026-08-29T14:59:00.000Z");
    const expiredCompleteToken = await bootstrapUser("dev-it-expired-complete");
    const expiredCompleteStart = await startQuiz(expiredCompleteToken);
    harness.setNow("2026-08-29T15:30:00.000Z");
    await seedHistoricalAnswers(expiredCompleteStart);
    harness.setNow("2026-08-29T16:00:00.000Z");
    const expiredComplete = await completeQuiz(
      expiredCompleteToken,
      expiredCompleteStart,
      "expired-complete-1",
    );
    expectApiError(expiredComplete, 409, "ATTEMPT_ABANDONED");

    const expiredCompleteState = await harness.database.client<
      { status: string; idempotency_count: number }[]
    >`
      SELECT
        a.status::text AS status,
        (
          SELECT count(*)::int
          FROM idempotency_records ir
          WHERE ir.operation = ${`batch-complete:${expiredCompleteStart.attempt.id}`}
        ) AS idempotency_count
      FROM attempts a
      WHERE a.id = ${expiredCompleteStart.attempt.id}
    `;
    assert.deepEqual(expiredCompleteState[0], {
      status: "abandoned",
      idempotency_count: 0,
    });
    const replay = await completeQuiz(
      beforeMidnightToken,
      beforeMidnight,
      "grace-complete-1",
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), graceComplete.json());
  } finally {
    harness.setNow(PRIMARY_DAY_NOON);
  }
});

test("ordinary attempt resume abandons at the daily deadline without challenge provenance", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-ordinary-resume-deadline");
  const start = await startQuiz(token);
  const rows = await harness.database.client<
    { daily_set_id: string; challenge_id: string | null }[]
  >`
    SELECT daily_set_id, challenge_id
    FROM attempts
    WHERE id = ${start.attempt.id}
  `;
  assert.equal(rows[0]!.challenge_id, null);
  const resumeAt = (now: Date) =>
    harness.database.client.begin((transaction) =>
      startOrResumeAttempt(transaction, {
        userId: getTokenUserId(token),
        now,
        setFilter: { dailySetId: rows[0]!.daily_set_id },
      }),
    );

  const before = await resumeAt(new Date("2026-08-29T15:59:59.999Z"));
  assert.equal(before.status, "available");
  if (before.status !== "available") {
    assert.fail("daily set must be available in this fixture");
  }
  assert.equal(before.attempt.status, "started");

  const expired = await resumeAt(new Date("2026-08-29T16:00:00.000Z"));
  if (expired.status !== "available") {
    assert.fail("daily set must be available in this fixture");
  }
  assert.equal(expired.attempt.id, start.attempt.id);
  assert.equal(expired.attempt.status, "abandoned");
  const abandoned = await harness.database.client<
    { abandoned_at: Date | string }[]
  >`
    SELECT abandoned_at FROM attempts WHERE id = ${start.attempt.id}
  `;
  assert.equal(
    new Date(abandoned[0]!.abandoned_at).toISOString(),
    "2026-08-29T16:00:00.000Z",
  );
});

test("database constraints and immutability triggers reject invalid writes", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-db-probes");
  const start = await startQuiz(token);
  await seedHistoricalAnswer(
    start.attempt.id,
    start.questions[0]!,
    correctSelections[0],
  );

  const setRows = await harness.database.client<{ daily_set_id: string }[]>`
    SELECT daily_set_id
    FROM attempts
    WHERE id = ${start.attempt.id}
  `;
  const dailySetId = setRows[0]!.daily_set_id;

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
      UPDATE daily_sets
      SET status = 'draft'
      WHERE id = ${dailySetId}
    `;
  }, /daily set status transition is not allowed/);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
      DELETE FROM daily_sets
      WHERE id = ${dailySetId}
    `;
  }, /published daily sets cannot be deleted/);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
        UPDATE attempt_answers
        SET selected_index = 1
        WHERE attempt_id = ${start.attempt.id} AND sequence = 1
      `;
  }, /submitted answers are immutable/);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
        DELETE FROM attempt_answers
        WHERE attempt_id = ${start.attempt.id} AND sequence = 1
      `;
  }, /submitted answers are immutable/);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
        INSERT INTO attempt_answers (
          attempt_id,
          sequence,
          question_revision_id,
          selected_index
        )
        VALUES (
          ${start.attempt.id},
          2,
          ${start.questions[1]!.revisionId},
          4
        )
      `;
  }, /attempt_answers_selected_index_ck/);

  await expectDatabaseFailure(async (transaction) => {
    const draft = await transaction<{ id: string }[]>`
        INSERT INTO daily_sets (quiz_date, status)
        VALUES ('2030-01-03', 'draft')
        RETURNING id
      `;
    await transaction`
        INSERT INTO daily_set_items (
          daily_set_id,
          position,
          question_revision_id,
          choice_order
        )
        VALUES (
          ${draft[0]!.id},
          1,
          ${start.questions[0]!.revisionId},
          ${JSON.stringify([0, 0, 1, 2])}::jsonb
        )
      `;
  }, /daily_set_items_choice_order_ck/);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
        UPDATE attempts
        SET status = 'completed', score = 6, completed_at = now()
        WHERE id = ${start.attempt.id}
      `;
  }, /attempts_(score|state)_ck/);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
        UPDATE question_revisions
        SET prompt = '변조된 문제'
        WHERE id = ${start.questions[0]!.revisionId}
      `;
  }, /published question revisions are immutable/);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
        DELETE FROM daily_set_items
        WHERE daily_set_id = ${dailySetId} AND position = 1
      `;
  }, /published daily set items are immutable/);

  await expectDatabaseFailure(async (transaction) => {
    const draft = await transaction<{ id: string }[]>`
        INSERT INTO daily_sets (quiz_date, status)
        VALUES ('2030-01-02', 'draft')
        RETURNING id
      `;
    await transaction`
        UPDATE daily_set_items
        SET daily_set_id = ${draft[0]!.id}
        WHERE daily_set_id = ${dailySetId} AND position = 1
      `;
  }, /published daily set items are immutable/);

  await expectDatabaseFailure(async (transaction) => {
    const draft = await transaction<{ id: string }[]>`
        INSERT INTO daily_sets (quiz_date, status)
        VALUES ('2030-01-01', 'draft')
        RETURNING id
      `;
    await transaction`
        INSERT INTO daily_set_items (
          daily_set_id,
          position,
          question_revision_id
        )
        SELECT
          ${draft[0]!.id},
          row_number() OVER (ORDER BY id)::smallint,
          id
        FROM question_revisions
        ORDER BY id
        LIMIT 4
      `;
    await transaction`
        UPDATE daily_sets
        SET status = 'published', published_at = now()
        WHERE id = ${draft[0]!.id}
      `;
  }, /published daily sets must have exactly five items/);

  const completed = await completeQuiz(token, start, "db-probe-complete-1");
  assert.equal(completed.statusCode, 200, completed.body);

  await expectDatabaseFailure(async (transaction) => {
    await transaction`
        INSERT INTO attempt_answers (
          attempt_id,
          sequence,
          question_revision_id,
          selected_index
        )
        VALUES (
          ${start.attempt.id},
          1,
          ${start.questions[0]!.revisionId},
          0
        )
      `;
  }, /answers can only be inserted into started attempts/);

  const answerCount = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM attempt_answers
    WHERE attempt_id = ${start.attempt.id}
  `;
  assert.equal(answerCount[0]?.count, 5);
});

test(
  "publishing serializes with concurrent daily set item deletion",
  { timeout: 5_000 },
  async () => {
    const sets = await harness.database.client<{ id: string }[]>`
      INSERT INTO daily_sets (quiz_date, status)
      VALUES ('2030-01-03', 'draft')
      RETURNING id
    `;
    const dailySetId = sets[0]!.id;

    await harness.database.client`
      INSERT INTO daily_set_items (
        daily_set_id,
        position,
        question_revision_id
      )
      SELECT
        ${dailySetId},
        row_number() OVER (ORDER BY id)::smallint,
        id
      FROM question_revisions
      WHERE lifecycle_status = 'published'
      ORDER BY id
      LIMIT 5
    `;

    let markPublishLocked!: () => void;
    let rejectPublishLocked!: (reason?: unknown) => void;
    const publishLocked = new Promise<void>((resolve, reject) => {
      markPublishLocked = resolve;
      rejectPublishLocked = reject;
    });
    let releasePublish!: () => void;
    const holdPublish = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });

    const publishing = harness.database.client.begin(async (transaction) => {
      await transaction`
        UPDATE daily_sets
        SET status = 'published', published_at = now()
        WHERE id = ${dailySetId}
      `;
      markPublishLocked();
      await holdPublish;
    });
    void publishing.catch(rejectPublishLocked);

    try {
      await publishLocked;
      await expectDatabaseFailure(async (transaction) => {
        await transaction`
          SELECT set_config('lock_timeout', '250ms', true)
        `;
        await transaction`
          DELETE FROM daily_set_items
          WHERE daily_set_id = ${dailySetId}
            AND position = 1
        `;
      }, /canceling statement due to lock timeout/);
    } finally {
      releasePublish();
      await publishing;
    }

    const state = await harness.database.client<
      { status: string; published: boolean; item_count: number }[]
    >`
      SELECT
        ds.status::text AS status,
        (ds.published_at IS NOT NULL) AS published,
        count(dsi.position)::int AS item_count
      FROM daily_sets ds
      LEFT JOIN daily_set_items dsi ON dsi.daily_set_id = ds.id
      WHERE ds.id = ${dailySetId}
      GROUP BY ds.id
    `;
    assert.deepEqual(state[0], {
      status: "published",
      published: true,
      item_count: 5,
    });
  },
);

test("voided daily sets suppress every progress state and preserve historical rows", async () => {
  const voidedAt = "2026-08-29T03:30:00.000Z";
  harness.setNow(PRIMARY_DAY_NOON);
  const untouchedToken = await bootstrapUser("dev-it-void-untouched");
  const zeroToken = await bootstrapUser("dev-it-void-zero");
  const partialToken = await bootstrapUser("dev-it-void-partial");
  const fiveAnswerToken = await bootstrapUser("dev-it-void-five-answers");
  const completedToken = await bootstrapUser("dev-it-void-completed");
  const zeroStart = await startQuiz(zeroToken);
  const partialStart = await startQuiz(partialToken);
  const fiveAnswerStart = await startQuiz(fiveAnswerToken);
  const completedStart = await startQuiz(completedToken);

  await seedHistoricalAnswers(partialStart, 4);
  await seedHistoricalAnswers(fiveAnswerStart);
  const preVoidCompletion = await completeQuiz(
    completedToken,
    completedStart,
    "void-completed-old-key",
  );
  assert.equal(preVoidCompletion.statusCode, 200, preVoidCompletion.body);
  assert.equal(parseCompletedAttempt(preVoidCompletion.json()).score, 5);

  const setRows = await harness.database.client<{ daily_set_id: string }[]>`
    SELECT daily_set_id
    FROM attempts
    WHERE id = ${completedStart.attempt.id}
  `;
  const dailySetId = setRows[0]!.daily_set_id;
  const trackedAttemptIds = [
    zeroStart.attempt.id,
    partialStart.attempt.id,
    fiveAnswerStart.attempt.id,
    completedStart.attempt.id,
  ];
  const historicalBefore = await harness.database.client<
    {
      id: string;
      attempt_state: string;
      answer_state: string;
      user_state: string;
    }[]
  >`
    SELECT
      a.id,
      row_to_json(a)::text AS attempt_state,
      (
        SELECT coalesce(
          jsonb_agg(row_to_json(aa) ORDER BY aa.sequence),
          '[]'::jsonb
        )::text
        FROM attempt_answers aa
        WHERE aa.attempt_id = a.id
      ) AS answer_state,
      row_to_json(u)::text AS user_state
    FROM attempts a
    JOIN users u ON u.id = a.user_id
    WHERE a.id IN ${harness.database.client(trackedAttemptIds)}
    ORDER BY a.id
  `;
  const oldCompletionRecord = await harness.database.client<
    { response_body: string }[]
  >`
    SELECT response_body::text AS response_body
    FROM idempotency_records
    WHERE user_id = ${getTokenUserId(completedToken)}
      AND operation = ${`batch-complete:${completedStart.attempt.id}`}
      AND status = 'completed'
  `;
  assert.equal(oldCompletionRecord.length, 1);

  await harness.database.client`
    INSERT INTO daily_set_voids (
      daily_set_id,
      actor_subject,
      reason,
      voided_at
    )
    VALUES (
      ${dailySetId},
      'daily-integration-operator',
      '정답 기준 오류',
      ${voidedAt}
    )
  `;

  const startResponses = await Promise.all(
    [
      untouchedToken,
      zeroToken,
      partialToken,
      fiveAnswerToken,
      completedToken,
    ].map((token) =>
      harness.app.inject({
        method: "POST",
        url: "/v1/daily/start",
        headers: authorizationHeaders(token),
        payload: {},
      }),
    ),
  );
  for (const response of startResponses) {
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    const projection = DailyStartResponseSchema.parse(body);
    assert.equal(projection.status, "voided");
    assert.deepEqual(Object.keys(body as object).sort(), [
      "quizDate",
      "status",
      "voidedAt",
    ]);
    assert.equal("completedResult" in body, false);
    assert.doesNotMatch(
      JSON.stringify(body),
      /attempt|answer|question|review|score/i,
    );
    assert.equal(response.body.includes("daily-integration-operator"), false);
    assert.equal(response.body.includes("정답 기준 오류"), false);
  }
  const untouchedAttempts = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM attempts
    WHERE user_id = ${getTokenUserId(untouchedToken)}
      AND daily_set_id = ${dailySetId}
  `;
  assert.equal(untouchedAttempts[0]?.count, 0);

  for (const [token, start, key] of [
    [zeroToken, zeroStart, "void-zero-complete"],
    [partialToken, partialStart, "void-partial-complete"],
    [fiveAnswerToken, fiveAnswerStart, "void-five-answers-complete"],
    [completedToken, completedStart, "void-completed-old-key"],
    [completedToken, completedStart, "void-completed-new-key"],
  ] as const) {
    const response = await completeQuiz(token, start, key);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    const projection = CompleteAttemptResponseSchema.parse(body);
    assert.equal(projection.status, "voided");
    assert.deepEqual(Object.keys(body as object).sort(), [
      "attemptId",
      "quizDate",
      "status",
      "voidedAt",
    ]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /answers|questions|review|score|total|completedAt/i,
    );
    assert.equal(response.body.includes("daily-integration-operator"), false);
    assert.equal(response.body.includes("정답 기준 오류"), false);
  }
  const changedVoidReplay = await completeQuiz(
    completedToken,
    completedStart,
    "void-completed-old-key",
    batch(completedStart, [1, 2, 1, 1, 3]),
  );
  assert.equal(changedVoidReplay.statusCode, 200, changedVoidReplay.body);
  assert.equal(
    CompleteAttemptResponseSchema.parse(changedVoidReplay.json()).status,
    "voided",
  );
  expectApiError(
    await completeQuiz(
      untouchedToken,
      completedStart,
      "void-completed-old-key",
    ),
    403,
    "FORBIDDEN",
  );

  const historicalAfter = await harness.database.client<
    {
      id: string;
      attempt_state: string;
      answer_state: string;
      user_state: string;
    }[]
  >`
    SELECT
      a.id,
      row_to_json(a)::text AS attempt_state,
      (
        SELECT coalesce(
          jsonb_agg(row_to_json(aa) ORDER BY aa.sequence),
          '[]'::jsonb
        )::text
        FROM attempt_answers aa
        WHERE aa.attempt_id = a.id
      ) AS answer_state,
      row_to_json(u)::text AS user_state
    FROM attempts a
    JOIN users u ON u.id = a.user_id
    WHERE a.id IN ${harness.database.client(trackedAttemptIds)}
    ORDER BY a.id
  `;
  assert.deepEqual(historicalAfter, historicalBefore);
  const completionRecordsAfter = await harness.database.client<
    { response_body: string }[]
  >`
    SELECT response_body::text AS response_body
    FROM idempotency_records
    WHERE user_id = ${getTokenUserId(completedToken)}
      AND operation = ${`batch-complete:${completedStart.attempt.id}`}
      AND status = 'completed'
    ORDER BY id
  `;
  assert.deepEqual(completionRecordsAfter, oldCompletionRecord);
});
