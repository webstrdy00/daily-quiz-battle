import {
  CompleteAttemptRequestSchema,
  CompleteAttemptResponseSchema,
  DailyStartResponseSchema,
  type CompleteAttemptRequest,
  type CompleteAttemptResponse,
  type DailyStartResponse,
} from "@daily-quiz-battle/contracts";
import type { TransactionSql } from "postgres";
import type { Database } from "../db/client.js";
import { enqueueChallengeCompletionNotifications } from "../notification/outbox.js";
import { AppError } from "../shared/errors.js";
import { sha256 } from "../shared/hash.js";
import {
  addDays,
  getDailyCompletionDeadline,
  getKstDate,
} from "../shared/time.js";

export type Transaction = TransactionSql<{}>;

/**
 * Effective completion deadline for an attempt. A historical attempt created
 * through a challenge claim (ADR-0003) lives until its source challenge
 * expires; ordinary daily attempts end at D+1 01:00 KST.
 */
export async function getAttemptDeadline(
  transaction: Transaction,
  attemptId: string,
  quizDate: string,
): Promise<Date> {
  const dailyDeadline = getDailyCompletionDeadline(quizDate);
  const rows = await transaction<{ expires_at: Date | string | null }[]>`
    SELECT c.expires_at
    FROM attempts a
    LEFT JOIN challenges c ON c.id = a.challenge_id
    WHERE a.id = ${attemptId}
  `;
  const raw = rows[0]?.expires_at;
  if (raw === null || raw === undefined) {
    return dailyDeadline;
  }
  const challengeDeadline = raw instanceof Date ? raw : new Date(raw);
  return challengeDeadline > dailyDeadline ? challengeDeadline : dailyDeadline;
}

interface DailySetItemRow {
  daily_set_id: string;
  quiz_date: string;
  sequence: number;
  revision_id: string;
  prompt: string;
  choices: unknown;
  choice_order: unknown;
  lifecycle_status: string;
}

interface DailySetRow {
  id: string;
  quiz_date: string;
}

interface DailySetVoidRow {
  voided_at: Date | string;
}

interface AttemptRow {
  id: string;
  user_id: string;
  daily_set_id: string;
  challenge_id: string | null;
  status: "started" | "completed" | "abandoned";
  score: number | null;
  quiz_date: string;
  completed_at: Date | string | null;
}

interface AnswerRow extends ReviewRow {
  question_revision_id: string;
}

interface IdempotencyRow {
  request_hash: string;
  status: "processing" | "completed";
  response_body: unknown;
}

interface ReviewRow {
  sequence: number;
  prompt: string;
  selected_index: number;
  correct_index: number;
  choice_order: unknown;
  explanation: string;
}

function mapReview(rows: ReviewRow[]) {
  if (rows.length !== 5) {
    throw new AppError({
      statusCode: 422,
      code: "ANSWERS_INCOMPLETE",
      message: "5문제를 모두 제출한 뒤 완료해 주세요.",
      details: { answeredCount: rows.length },
    });
  }

  return rows.map((row) => {
    const correctIndex = getDisplayedChoiceIndex(
      row.correct_index,
      row.choice_order,
    );
    return {
      sequence: row.sequence,
      prompt: row.prompt,
      selectedIndex: row.selected_index,
      correctIndex,
      correct: row.selected_index === correctIndex,
      explanation: row.explanation,
    };
  });
}

function toChoiceTuple(value: unknown): [string, string, string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((choice) => typeof choice !== "string" || choice.length === 0)
  ) {
    throw new AppError({
      statusCode: 503,
      code: "CONTENT_INTEGRITY_ERROR",
      message: "오늘 문제를 준비하지 못했습니다.",
      retryable: true,
    });
  }

  return [value[0], value[1], value[2], value[3]];
}

function toChoiceOrder(value: unknown): [number, number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (index) =>
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 3,
    ) ||
    new Set(value).size !== 4
  ) {
    throw new AppError({
      statusCode: 503,
      code: "CONTENT_INTEGRITY_ERROR",
      message: "오늘 문제를 준비하지 못했습니다.",
      retryable: true,
    });
  }

  return [value[0], value[1], value[2], value[3]];
}

function applyChoiceOrder(
  choicesValue: unknown,
  orderValue: unknown,
): [string, string, string, string] {
  const choices = toChoiceTuple(choicesValue);
  const orderedChoices = toChoiceOrder(orderValue).map(
    (index) => choices[index],
  );
  return toChoiceTuple(orderedChoices);
}

function getDisplayedChoiceIndex(
  originalIndex: number,
  orderValue: unknown,
): number {
  const displayedIndex = toChoiceOrder(orderValue).indexOf(originalIndex);
  if (displayedIndex === -1) {
    throw new AppError({
      statusCode: 503,
      code: "CONTENT_INTEGRITY_ERROR",
      message: "오늘 문제를 준비하지 못했습니다.",
      retryable: true,
    });
  }
  return displayedIndex;
}

function toIsoDateTime(value: Date | string | null): string {
  if (value === null) {
    throw new AppError({
      statusCode: 500,
      code: "DATA_INTEGRITY_ERROR",
      message: "완료 결과를 불러오지 못했습니다.",
    });
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      statusCode: 500,
      code: "DATA_INTEGRITY_ERROR",
      message: "완료 결과를 불러오지 못했습니다.",
    });
  }
  return date.toISOString();
}

async function loadDailySetVoid(
  transaction: Transaction,
  dailySetId: string,
): Promise<DailySetVoidRow | undefined> {
  const rows = await transaction<DailySetVoidRow[]>`
    SELECT voided_at
    FROM daily_set_voids
    WHERE daily_set_id = ${dailySetId}
  `;
  return rows[0];
}

async function lockActiveUser(
  transaction: Transaction,
  userId: string,
): Promise<void> {
  const users = await transaction<
    { identity_status: "active" | "deleted" | "blocked" }[]
  >`
    SELECT identity_status::text AS identity_status
    FROM users
    WHERE id = ${userId}
    FOR UPDATE
  `;
  if (users[0]?.identity_status !== "active") {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "현재 사용할 수 없는 계정입니다.",
    });
  }
}

export async function startDailyQuiz(
  database: Database,
  userId: string,
  now = new Date(),
): Promise<DailyStartResponse> {
  const quizDate = getKstDate(now);
  return database.client.begin((transaction) =>
    startOrResumeAttempt(transaction, {
      userId,
      now,
      setFilter: { quizDate },
    }),
  );
}

export interface StartOrResumeOptions {
  userId: string;
  now: Date;
  setFilter: { quizDate: string } | { dailySetId: string };
  /** Immutable provenance for an attempt newly created by a challenge claim. */
  challengeId?: string;
}

/**
 * Shared by `POST /v1/daily/start` and challenge claim. Runs inside the
 * caller's transaction. Re-locking a user already locked by challenge claim
 * is safe and keeps this helper correct for every caller.
 */
export async function startOrResumeAttempt(
  transaction: Transaction,
  options: StartOrResumeOptions,
): Promise<DailyStartResponse> {
  const { userId, now, setFilter, challengeId } = options;
  await lockActiveUser(transaction, userId);
  {
    const dailySets =
      "quizDate" in setFilter
        ? await transaction<DailySetRow[]>`
      SELECT ds.id, ds.quiz_date::text AS quiz_date
      FROM daily_sets ds
      WHERE ds.quiz_date = ${setFilter.quizDate}
        AND ds.status = 'published'
      FOR SHARE OF ds
    `
        : await transaction<DailySetRow[]>`
      SELECT ds.id, ds.quiz_date::text AS quiz_date
      FROM daily_sets ds
      WHERE ds.id = ${setFilter.dailySetId}
        AND ds.status = 'published'
      FOR SHARE OF ds
    `;
    const dailySet = dailySets[0];
    if (dailySet === undefined) {
      throw new AppError({
        statusCode: 503,
        code: "DAILY_SET_NOT_READY",
        message: "오늘 문제를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
        retryable: true,
      });
    }

    const dailySetVoid = await loadDailySetVoid(transaction, dailySet.id);
    if (dailySetVoid !== undefined) {
      return DailyStartResponseSchema.parse({
        status: "voided",
        quizDate: dailySet.quiz_date,
        voidedAt: toIsoDateTime(dailySetVoid.voided_at),
      });
    }

    let attempts = await transaction<AttemptRow[]>`
      SELECT
        a.id,
        a.user_id,
        a.daily_set_id,
        a.challenge_id,
        a.status::text AS status,
        a.score::int AS score,
        ds.quiz_date::text AS quiz_date,
        a.completed_at
      FROM attempts a
      JOIN daily_sets ds ON ds.id = a.daily_set_id
      WHERE a.user_id = ${userId}
        AND a.daily_set_id = ${dailySet.id}
      FOR UPDATE OF a
    `;
    let attempt = attempts[0];

    // New attempts share-lock their revisions so retirement cannot commit
    // between lifecycle validation and attempt creation. Existing attempts
    // deliberately read the immutable set snapshot without a lifecycle gate.
    const items =
      attempt === undefined
        ? await transaction<DailySetItemRow[]>`
      SELECT
        ds.id AS daily_set_id,
        ds.quiz_date::text AS quiz_date,
        dsi.position::int AS sequence,
        qr.id AS revision_id,
        qr.prompt,
        qr.choices,
        dsi.choice_order,
        qr.lifecycle_status::text AS lifecycle_status
      FROM daily_sets ds
      JOIN daily_set_items dsi ON dsi.daily_set_id = ds.id
      JOIN question_revisions qr ON qr.id = dsi.question_revision_id
      WHERE ds.id = ${dailySet.id}
      ORDER BY dsi.position
      FOR SHARE OF qr
    `
        : await transaction<DailySetItemRow[]>`
      SELECT
        ds.id AS daily_set_id,
        ds.quiz_date::text AS quiz_date,
        dsi.position::int AS sequence,
        qr.id AS revision_id,
        qr.prompt,
        qr.choices,
        dsi.choice_order,
        qr.lifecycle_status::text AS lifecycle_status
      FROM daily_sets ds
      JOIN daily_set_items dsi ON dsi.daily_set_id = ds.id
      JOIN question_revisions qr ON qr.id = dsi.question_revision_id
      WHERE ds.id = ${dailySet.id}
      ORDER BY dsi.position
    `;

    if (items.length !== 5) {
      throw new AppError({
        statusCode: 503,
        code: "DAILY_SET_NOT_READY",
        message: "오늘 문제를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
        retryable: true,
      });
    }

    if (attempt === undefined) {
      if (items.some((item) => item.lifecycle_status !== "published")) {
        throw new AppError({
          statusCode: 503,
          code: "DAILY_SET_NOT_READY",
          message: "오늘 문제를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
          retryable: true,
        });
      }

      await transaction`
        INSERT INTO attempts (user_id, daily_set_id, challenge_id)
        VALUES (${userId}, ${dailySet.id}, ${challengeId ?? null})
        ON CONFLICT (user_id, daily_set_id) DO NOTHING
      `;
      attempts = await transaction<AttemptRow[]>`
        SELECT
          a.id,
          a.user_id,
          a.daily_set_id,
          a.challenge_id,
          a.status::text AS status,
          a.score::int AS score,
          ds.quiz_date::text AS quiz_date,
          a.completed_at
        FROM attempts a
        JOIN daily_sets ds ON ds.id = a.daily_set_id
        WHERE a.user_id = ${userId}
          AND a.daily_set_id = ${dailySet.id}
        FOR UPDATE OF a
      `;
      attempt = attempts[0];
    }

    if (attempt === undefined) {
      throw new AppError({
        statusCode: 500,
        code: "ATTEMPT_CREATE_FAILED",
        message: "퀴즈를 시작하지 못했습니다.",
      });
    }

    const deadline =
      attempt.challenge_id === null
        ? getDailyCompletionDeadline(attempt.quiz_date)
        : await getAttemptDeadline(transaction, attempt.id, attempt.quiz_date);
    if (attempt.status === "started" && now >= deadline) {
      const abandoned = await transaction<AttemptRow[]>`
        UPDATE attempts
        SET status = 'abandoned', abandoned_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
        WHERE id = ${attempt.id} AND status = 'started'
        RETURNING
          id,
          user_id,
          daily_set_id,
          challenge_id,
          status::text AS status,
          score::int AS score,
          ${attempt.quiz_date}::text AS quiz_date,
          completed_at
      `;
      attempt = abandoned[0] ?? attempt;
    }

    const answers = await transaction<AnswerRow[]>`
      SELECT
        aa.sequence::int AS sequence,
        aa.question_revision_id,
        aa.selected_index::int AS selected_index,
        qr.prompt,
        qr.correct_index::int AS correct_index,
        dsi.choice_order,
        qr.explanation
      FROM attempt_answers aa
      JOIN question_revisions qr ON qr.id = aa.question_revision_id
      JOIN daily_set_items dsi
        ON dsi.daily_set_id = ${attempt.daily_set_id}
        AND dsi.question_revision_id = aa.question_revision_id
      WHERE aa.attempt_id = ${attempt.id}
      ORDER BY aa.sequence
    `;

    return DailyStartResponseSchema.parse({
      status: "available",
      attempt: {
        id: attempt.id,
        status: attempt.status,
        quizDate: attempt.quiz_date,
        answeredCount: answers.length,
        score: attempt.score,
        answers: answers.map((answer) => ({
          sequence: answer.sequence,
          questionRevisionId: answer.question_revision_id,
          selectedIndex: answer.selected_index,
        })),
      },
      questions: items.map((item) => ({
        sequence: item.sequence,
        revisionId: item.revision_id,
        prompt: item.prompt,
        choices: applyChoiceOrder(item.choices, item.choice_order),
      })),
      ...(attempt.status === "completed"
        ? {
            completedResult: {
              attemptId: attempt.id,
              status: "completed",
              score: attempt.score,
              total: 5,
              completedAt: toIsoDateTime(attempt.completed_at),
              review: mapReview(answers),
            },
          }
        : {}),
    });
  }
}

export async function completeAttempt(
  database: Database,
  userId: string,
  attemptId: string,
  idempotencyKey: string,
  request: CompleteAttemptRequest,
  now = new Date(),
  notificationDeliveryEnabled = true,
): Promise<CompleteAttemptResponse> {
  const answers = CompleteAttemptRequestSchema.parse(request)
    .answers.map((answer) => ({
      sequence: answer.sequence,
      questionRevisionId: answer.questionRevisionId,
      selectedIndex: answer.selectedIndex,
    }))
    .sort((left, right) => left.sequence - right.sequence);
  const operation = `batch-complete:${attemptId}`;
  const keyHash = sha256(idempotencyKey);
  const requestHash = sha256(JSON.stringify({ answers }));

  const result = await database.client.begin(async (transaction) => {
    await lockActiveUser(transaction, userId);

    const attempts = await transaction<AttemptRow[]>`
      SELECT
        a.id,
        a.user_id,
        a.daily_set_id,
        a.challenge_id,
        a.status::text AS status,
        a.score::int AS score,
        ds.quiz_date::text AS quiz_date,
        a.completed_at
      FROM attempts a
      JOIN daily_sets ds ON ds.id = a.daily_set_id
      WHERE a.id = ${attemptId}
      FOR UPDATE OF a
      FOR SHARE OF ds
    `;
    const attempt = attempts[0];

    if (attempt === undefined) {
      throw new AppError({
        statusCode: 404,
        code: "ATTEMPT_NOT_FOUND",
        message: "퀴즈 진행 정보를 찾을 수 없습니다.",
      });
    }
    if (attempt.user_id !== userId) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "이 퀴즈를 완료할 권한이 없습니다.",
      });
    }

    const dailySetVoid = await loadDailySetVoid(
      transaction,
      attempt.daily_set_id,
    );
    if (dailySetVoid !== undefined) {
      return {
        response: CompleteAttemptResponseSchema.parse({
          status: "voided",
          attemptId,
          quizDate: attempt.quiz_date,
          voidedAt: toIsoDateTime(dailySetVoid.voided_at),
        }),
      };
    }

    const insertedIdempotency = await transaction`
      INSERT INTO idempotency_records (
        user_id,
        operation,
        key_hash,
        request_hash,
        expires_at
      )
      VALUES (
        ${userId},
        ${operation},
        ${keyHash},
        ${requestHash},
        now() + interval '24 hours'
      )
      ON CONFLICT (user_id, operation, key_hash) DO NOTHING
      RETURNING id
    `;

    if (insertedIdempotency.length === 0) {
      const existing = await transaction<IdempotencyRow[]>`
        SELECT request_hash, status::text AS status, response_body
        FROM idempotency_records
        WHERE user_id = ${userId}
          AND operation = ${operation}
          AND key_hash = ${keyHash}
      `;
      const record = existing[0];
      if (record?.request_hash !== requestHash) {
        throw new AppError({
          statusCode: 409,
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "같은 요청 키를 다른 내용에 사용할 수 없습니다.",
        });
      }
      if (record.status !== "completed" || record.response_body === null) {
        throw new AppError({
          statusCode: 409,
          code: "REQUEST_IN_PROGRESS",
          message: "같은 요청을 처리하고 있습니다.",
          retryable: true,
        });
      }
      return {
        response: CompleteAttemptResponseSchema.parse(record.response_body),
      };
    }

    if (attempt.status === "abandoned") {
      throw new AppError({
        statusCode: 409,
        code: "ATTEMPT_ABANDONED",
        message: "완료 가능 시간이 지난 퀴즈입니다.",
      });
    }

    if (
      attempt.status === "started" &&
      now >=
        (attempt.challenge_id === null
          ? getDailyCompletionDeadline(attempt.quiz_date)
          : await getAttemptDeadline(
              transaction,
              attempt.id,
              attempt.quiz_date,
            ))
    ) {
      await transaction`
        UPDATE attempts
        SET status = 'abandoned', abandoned_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
        WHERE id = ${attempt.id}
      `;
      await transaction`
        DELETE FROM idempotency_records
        WHERE user_id = ${userId}
          AND operation = ${operation}
          AND key_hash = ${keyHash}
      `;
      return {
        error: new AppError({
          statusCode: 409,
          code: "ATTEMPT_ABANDONED",
          message: "완료 가능 시간이 지난 퀴즈입니다.",
        }),
      };
    }

    const savedAnswers = await transaction<
      {
        sequence: number;
        question_revision_id: string;
        selected_index: number;
      }[]
    >`
      SELECT sequence::int AS sequence, question_revision_id,
        selected_index::int AS selected_index
      FROM attempt_answers
      WHERE attempt_id = ${attemptId}
      ORDER BY sequence
    `;
    const savedAnswersMatch = savedAnswers.every((saved) => {
      const answer = answers[saved.sequence - 1];
      return (
        answer !== undefined &&
        answer.questionRevisionId === saved.question_revision_id &&
        answer.selectedIndex === saved.selected_index
      );
    });
    if (
      attempt.status === "completed" &&
      (!savedAnswersMatch || savedAnswers.length !== 5)
    ) {
      throw new AppError({
        statusCode: 409,
        code: "ATTEMPT_ALREADY_COMPLETED",
        message: "이미 다른 답안으로 완료한 퀴즈입니다.",
      });
    }

    const setItems = await transaction<
      { sequence: number; question_revision_id: string }[]
    >`
      SELECT position::int AS sequence, question_revision_id
      FROM daily_set_items
      WHERE daily_set_id = ${attempt.daily_set_id}
      ORDER BY position
    `;
    if (
      setItems.length !== 5 ||
      answers.some(
        (answer, index) =>
          setItems[index]?.sequence !== answer.sequence ||
          setItems[index]?.question_revision_id !== answer.questionRevisionId,
      )
    ) {
      throw new AppError({
        statusCode: 409,
        code: "QUESTION_REVISION_CONFLICT",
        message: "문제 버전이 현재 퀴즈와 일치하지 않습니다.",
      });
    }
    if (!savedAnswersMatch) {
      throw new AppError({
        statusCode: 409,
        code: "SAVED_ANSWER_CONFLICT",
        message: "이미 제출한 답안은 변경할 수 없습니다.",
      });
    }

    const savedSequences = new Set(
      savedAnswers.map((answer) => answer.sequence),
    );
    const missingAnswers = answers
      .filter((answer) => !savedSequences.has(answer.sequence))
      .map((answer) => ({
        attempt_id: attemptId,
        sequence: answer.sequence,
        question_revision_id: answer.questionRevisionId,
        selected_index: answer.selectedIndex,
        received_at: now.toISOString(),
      }));
    if (missingAnswers.length > 0) {
      await transaction`
        INSERT INTO attempt_answers ${transaction(
          missingAnswers,
          "attempt_id",
          "sequence",
          "question_revision_id",
          "selected_index",
          "received_at",
        )}
      `;
    }

    const reviewRows = await transaction<ReviewRow[]>`
      SELECT
        aa.sequence::int AS sequence,
        qr.prompt,
        aa.selected_index::int AS selected_index,
        qr.correct_index::int AS correct_index,
        dsi.choice_order,
        qr.explanation
      FROM attempt_answers aa
      JOIN attempts a ON a.id = aa.attempt_id
      JOIN question_revisions qr ON qr.id = aa.question_revision_id
      JOIN daily_set_items dsi
        ON dsi.daily_set_id = a.daily_set_id
        AND dsi.question_revision_id = aa.question_revision_id
      WHERE aa.attempt_id = ${attemptId}
      ORDER BY aa.sequence
    `;

    const review = mapReview(reviewRows);

    let score = attempt.score;
    let completedAt = attempt.completed_at;

    if (attempt.status === "started") {
      score = review.filter((item) => item.correct).length;
      const completed = await transaction<
        { score: number; completed_at: Date | string }[]
      >`
        UPDATE attempts
        SET
          status = 'completed',
          score = ${score},
          completed_at = ${now.toISOString()},
          updated_at = ${now.toISOString()}
        WHERE id = ${attemptId} AND status = 'started'
        RETURNING score::int AS score, completed_at
      `;
      score = completed[0]!.score;
      completedAt = completed[0]!.completed_at;

      // Finalize any challenge that references this attempt as opponent.
      // Row lock on the challenge keeps this serialized with concurrent
      // claim/result readers; the state trigger rejects illegal transitions.
      const completedChallenges = await transaction<{ id: string }[]>`
        UPDATE challenges
        SET
          status = 'completed',
          opponent_score = ${score},
          completed_at = ${now.toISOString()},
          updated_at = ${now.toISOString()}
        WHERE id IN (
          SELECT id FROM challenges
          WHERE opponent_attempt_id = ${attemptId}
            AND status = 'claimed'
            AND result_redacted_at IS NULL
          ORDER BY id
          FOR UPDATE
        )
        RETURNING id
      `;
      await enqueueChallengeCompletionNotifications(
        transaction,
        completedChallenges.map((challenge) => challenge.id),
        notificationDeliveryEnabled,
      );

      const previousDate = addDays(attempt.quiz_date, -1);
      await transaction`
        UPDATE users
        SET
          streak_days = CASE
            WHEN last_daily_date = ${attempt.quiz_date}::date THEN streak_days
            WHEN last_daily_date = ${previousDate}::date THEN streak_days + 1
            ELSE 1
          END,
          last_daily_date = ${attempt.quiz_date}::date,
          updated_at = ${now.toISOString()}
        WHERE id = ${userId}
          AND (
            last_daily_date IS NULL
            OR last_daily_date <= ${attempt.quiz_date}::date
          )
      `;
    }

    if (score === null) {
      throw new AppError({
        statusCode: 500,
        code: "DATA_INTEGRITY_ERROR",
        message: "완료 점수를 불러오지 못했습니다.",
      });
    }

    const response = CompleteAttemptResponseSchema.parse({
      attemptId,
      status: "completed",
      score,
      total: 5,
      completedAt: toIsoDateTime(completedAt),
      review,
    });

    await transaction`
      UPDATE idempotency_records
      SET
        status = 'completed',
        response_status = 200,
        response_body = ${JSON.stringify(response)}::jsonb,
        resource_id = ${attemptId}
      WHERE user_id = ${userId}
        AND operation = ${operation}
        AND key_hash = ${keyHash}
    `;

    return { response };
  });

  if ("error" in result && result.error !== undefined) {
    throw result.error;
  }
  return result.response;
}
