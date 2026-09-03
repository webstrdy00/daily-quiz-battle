import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  CompleteAttemptResponseSchema,
  DailyStartResponseSchema,
  SubmitAnswerResponseSchema,
  type DailyStartResponse,
  type PublicQuestion,
  type SubmitAnswerRequest,
} from "@daily-quiz-battle/contracts";
import { decodeJwt } from "jose";
import type postgres from "postgres";
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

async function startQuiz(token: string): Promise<DailyStartResponse> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(token),
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  return DailyStartResponseSchema.parse(response.json());
}

function answerPayload(
  question: PublicQuestion,
  selectedIndex: number,
): SubmitAnswerRequest {
  return {
    sequence: question.sequence,
    questionRevisionId: question.revisionId,
    selectedIndex,
  };
}

async function submitAnswer(
  token: string,
  attemptId: string,
  idempotencyKey: string,
  payload: SubmitAnswerRequest,
) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/answers`,
    headers: idempotentHeaders(token, idempotencyKey),
    payload,
  });
}

async function submitSuccessfulAnswer(
  token: string,
  attemptId: string,
  idempotencyKey: string,
  question: PublicQuestion,
  selectedIndex: number,
) {
  const response = await submitAnswer(
    token,
    attemptId,
    idempotencyKey,
    answerPayload(question, selectedIndex),
  );
  assert.equal(response.statusCode, 200, response.body);
  return SubmitAnswerResponseSchema.parse(response.json());
}

async function completeQuiz(
  token: string,
  attemptId: string,
  idempotencyKey: string,
) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${attemptId}/complete`,
    headers: idempotentHeaders(token, idempotencyKey),
    payload: {},
  });
}

async function answerAllQuestions(
  token: string,
  start: DailyStartResponse,
  keyPrefix: string,
): Promise<void> {
  for (const [index, question] of start.questions.entries()) {
    await submitSuccessfulAnswer(
      token,
      start.attempt.id,
      `${keyPrefix}-${index + 1}`,
      question,
      correctSelections[index]!,
    );
  }
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
  for (const question of start.questions) {
    assert.equal("correctIndex" in question, false);
    assert.equal("explanation" in question, false);
  }

  const firstPayload = answerPayload(start.questions[0]!, correctSelections[0]);
  const first = await submitAnswer(
    token,
    start.attempt.id,
    "happy-answer-1",
    firstPayload,
  );
  const firstReplay = await submitAnswer(
    token,
    start.attempt.id,
    "happy-answer-1",
    firstPayload,
  );
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(firstReplay.statusCode, 200, firstReplay.body);
  assert.deepEqual(
    SubmitAnswerResponseSchema.parse(firstReplay.json()),
    SubmitAnswerResponseSchema.parse(first.json()),
  );

  const conflict = await submitAnswer(
    token,
    start.attempt.id,
    "happy-answer-1",
    answerPayload(start.questions[0]!, 1),
  );
  expectApiError(conflict, 409, "IDEMPOTENCY_KEY_REUSED");

  for (let index = 1; index < start.questions.length; index += 1) {
    await submitSuccessfulAnswer(
      token,
      start.attempt.id,
      `happy-answer-${index + 1}`,
      start.questions[index]!,
      correctSelections[index]!,
    );
  }

  const completed = await completeQuiz(
    token,
    start.attempt.id,
    "happy-complete-1",
  );
  const completedReplay = await completeQuiz(
    token,
    start.attempt.id,
    "happy-complete-1",
  );
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completedReplay.statusCode, 200, completedReplay.body);
  const result = CompleteAttemptResponseSchema.parse(completed.json());
  assert.deepEqual(
    CompleteAttemptResponseSchema.parse(completedReplay.json()),
    result,
  );
  assert.equal(result.score, 5);
  assert.equal(result.review.length, 5);
  assert.ok(result.review.every((item) => item.correct));

  const completedResume = await startQuiz(token);
  assert.equal(completedResume.attempt.id, start.attempt.id);
  assert.equal(completedResume.attempt.status, "completed");
  assert.equal(completedResume.attempt.answeredCount, 5);
  assert.equal(completedResume.attempt.score, 5);

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
  assert.equal(idempotency[0]?.count, 6);
});

test("authentication, ownership, ordering, and failed idempotency roll back", async () => {
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

  const forbiddenAnswer = await submitAnswer(
    intruderToken,
    start.attempt.id,
    "owner-answer-forbidden",
    answerPayload(start.questions[0]!, 0),
  );
  expectApiError(forbiddenAnswer, 403, "FORBIDDEN");

  const forbiddenComplete = await completeQuiz(
    intruderToken,
    start.attempt.id,
    "owner-complete-forbidden",
  );
  expectApiError(forbiddenComplete, 403, "FORBIDDEN");

  const outOfOrder = await submitAnswer(
    ownerToken,
    start.attempt.id,
    "rollback-shared-1",
    answerPayload(start.questions[1]!, correctSelections[1]),
  );
  expectApiError(outOfOrder, 422, "ANSWER_OUT_OF_ORDER");

  await submitSuccessfulAnswer(
    ownerToken,
    start.attempt.id,
    "rollback-shared-1",
    start.questions[0]!,
    correctSelections[0],
  );

  const wrongRevision = await submitAnswer(
    ownerToken,
    start.attempt.id,
    "rollback-revision-2",
    {
      sequence: 2,
      questionRevisionId: start.questions[2]!.revisionId,
      selectedIndex: correctSelections[1],
    },
  );
  expectApiError(wrongRevision, 409, "QUESTION_REVISION_CONFLICT");

  await submitSuccessfulAnswer(
    ownerToken,
    start.attempt.id,
    "rollback-revision-2",
    start.questions[1]!,
    correctSelections[1],
  );

  const incomplete = await completeQuiz(
    ownerToken,
    start.attempt.id,
    "rollback-complete-1",
  );
  expectApiError(incomplete, 422, "ANSWERS_INCOMPLETE");

  for (let index = 2; index < start.questions.length; index += 1) {
    await submitSuccessfulAnswer(
      ownerToken,
      start.attempt.id,
      `rollback-answer-${index + 1}`,
      start.questions[index]!,
      correctSelections[index]!,
    );
  }

  const completed = await completeQuiz(
    ownerToken,
    start.attempt.id,
    "rollback-complete-1",
  );
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(CompleteAttemptResponseSchema.parse(completed.json()).score, 5);

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

test("concurrent start, answer, and complete requests converge", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-concurrency");
  const starts = await Promise.all(
    Array.from({ length: 8 }, () => startQuiz(token)),
  );
  const attemptIds = new Set(starts.map((value) => value.attempt.id));
  assert.equal(attemptIds.size, 1);
  const start = starts[0]!;
  const userId = getTokenUserId(token);

  const firstPayload = answerPayload(start.questions[0]!, correctSelections[0]);
  const concurrentAnswers = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      submitAnswer(
        token,
        start.attempt.id,
        `concurrent-race-answer-1-${index + 1}`,
        firstPayload,
      ),
    ),
  );
  const savedAnswers = concurrentAnswers.filter(
    (response) => response.statusCode === 200,
  );
  const duplicateAnswers = concurrentAnswers.filter(
    (response) => response.statusCode === 422,
  );
  assert.equal(savedAnswers.length, 1);
  assert.equal(duplicateAnswers.length, 7);
  assert.deepEqual(SubmitAnswerResponseSchema.parse(savedAnswers[0]!.json()), {
    attemptId: start.attempt.id,
    sequence: 1,
    saved: true,
    answeredCount: 1,
    nextSequence: 2,
  });
  for (const response of duplicateAnswers) {
    expectApiError(response, 422, "ANSWER_ALREADY_SUBMITTED");
  }

  const answerRaceState = await harness.database.client<
    {
      answer_count: number;
      completed_idempotency_count: number;
      processing_idempotency_count: number;
    }[]
  >`
    SELECT
      (
        SELECT count(*)::int
        FROM attempt_answers
        WHERE attempt_id = ${start.attempt.id}
      ) AS answer_count,
      (
        SELECT count(*)::int
        FROM idempotency_records
        WHERE user_id = ${userId}
          AND operation = ${`answer:${start.attempt.id}`}
          AND status = 'completed'
          AND response_status = 200
      ) AS completed_idempotency_count,
      (
        SELECT count(*)::int
        FROM idempotency_records
        WHERE user_id = ${userId}
          AND operation = ${`answer:${start.attempt.id}`}
          AND status = 'processing'
      ) AS processing_idempotency_count
  `;
  assert.deepEqual(answerRaceState[0], {
    answer_count: 1,
    completed_idempotency_count: 1,
    processing_idempotency_count: 0,
  });

  for (let index = 1; index < start.questions.length; index += 1) {
    await submitSuccessfulAnswer(
      token,
      start.attempt.id,
      `concurrent-answer-${index + 1}`,
      start.questions[index]!,
      correctSelections[index]!,
    );
  }

  const completes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      completeQuiz(token, start.attempt.id, `concurrent-complete-${index + 1}`),
    ),
  );
  assert.ok(
    completes.every((response) => response.statusCode === 200),
    completes.map((response) => response.body).join("\n"),
  );
  const firstComplete = CompleteAttemptResponseSchema.parse(
    completes[0]!.json(),
  );
  for (const response of completes.slice(1)) {
    assert.deepEqual(
      CompleteAttemptResponseSchema.parse(response.json()),
      firstComplete,
    );
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
          AND ir.operation = ${`complete:${start.attempt.id}`}
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
    answer_idempotency_count: 5,
    complete_idempotency_count: 8,
    processing_idempotency_count: 0,
  });
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

    harness.setNow("2026-08-29T15:30:00.000Z");
    for (let index = 0; index < 4; index += 1) {
      await submitSuccessfulAnswer(
        beforeMidnightToken,
        beforeMidnight.attempt.id,
        `grace-answer-${index + 1}`,
        beforeMidnight.questions[index]!,
        correctSelections[index]!,
      );
    }
    harness.setNow("2026-08-29T15:59:59.999Z");
    await submitSuccessfulAnswer(
      beforeMidnightToken,
      beforeMidnight.attempt.id,
      "grace-answer-5",
      beforeMidnight.questions[4]!,
      correctSelections[4],
    );
    const graceComplete = await completeQuiz(
      beforeMidnightToken,
      beforeMidnight.attempt.id,
      "grace-complete-1",
    );
    assert.equal(graceComplete.statusCode, 200, graceComplete.body);

    harness.setNow("2026-08-29T14:59:00.000Z");
    const expiredAnswerToken = await bootstrapUser("dev-it-expired-answer");
    const expiredAnswerStart = await startQuiz(expiredAnswerToken);
    harness.setNow("2026-08-29T16:00:00.000Z");
    const expiredAnswer = await submitAnswer(
      expiredAnswerToken,
      expiredAnswerStart.attempt.id,
      "expired-answer-1",
      answerPayload(expiredAnswerStart.questions[0]!, correctSelections[0]),
    );
    expectApiError(expiredAnswer, 409, "ATTEMPT_ABANDONED");

    const expiredAnswerState = await harness.database.client<
      { status: string; abandoned: boolean; idempotency_count: number }[]
    >`
      SELECT
        a.status::text AS status,
        (a.abandoned_at IS NOT NULL) AS abandoned,
        (
          SELECT count(*)::int
          FROM idempotency_records ir
          WHERE ir.operation = ${`answer:${expiredAnswerStart.attempt.id}`}
        ) AS idempotency_count
      FROM attempts a
      WHERE a.id = ${expiredAnswerStart.attempt.id}
    `;
    assert.deepEqual(expiredAnswerState[0], {
      status: "abandoned",
      abandoned: true,
      idempotency_count: 0,
    });

    harness.setNow("2026-08-29T14:59:00.000Z");
    const expiredCompleteToken = await bootstrapUser("dev-it-expired-complete");
    const expiredCompleteStart = await startQuiz(expiredCompleteToken);
    harness.setNow("2026-08-29T15:30:00.000Z");
    await answerAllQuestions(
      expiredCompleteToken,
      expiredCompleteStart,
      "expired-complete-answer",
    );
    harness.setNow("2026-08-29T16:00:00.000Z");
    const expiredComplete = await completeQuiz(
      expiredCompleteToken,
      expiredCompleteStart.attempt.id,
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
          WHERE ir.operation = ${`complete:${expiredCompleteStart.attempt.id}`}
        ) AS idempotency_count
      FROM attempts a
      WHERE a.id = ${expiredCompleteStart.attempt.id}
    `;
    assert.deepEqual(expiredCompleteState[0], {
      status: "abandoned",
      idempotency_count: 0,
    });
  } finally {
    harness.setNow(PRIMARY_DAY_NOON);
  }
});

test("database constraints and immutability triggers reject invalid writes", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const token = await bootstrapUser("dev-it-db-probes");
  const start = await startQuiz(token);
  await submitSuccessfulAnswer(
    token,
    start.attempt.id,
    "db-probe-answer-1",
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

  for (let index = 1; index < start.questions.length; index += 1) {
    await submitSuccessfulAnswer(
      token,
      start.attempt.id,
      `db-probe-answer-${index + 1}`,
      start.questions[index]!,
      correctSelections[index]!,
    );
  }
  const completed = await completeQuiz(
    token,
    start.attempt.id,
    "db-probe-complete-1",
  );
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
