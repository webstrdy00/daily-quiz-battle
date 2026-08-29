import {
  CompleteAttemptResponseSchema,
  DailyStartResponseSchema,
  SubmitAnswerResponseSchema,
  type CompleteAttemptResponse,
  type DailyStartResponse,
  type SubmitAnswerRequest,
  type SubmitAnswerResponse,
} from "@daily-quiz-battle/contracts";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";
import { sha256 } from "../shared/hash.js";
import {
  addDays,
  getKstDate,
  isPastDailyCompletionDeadline,
} from "../shared/time.js";

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

interface AttemptRow {
  id: string;
  user_id: string;
  status: "started" | "completed" | "abandoned";
  score: number | null;
  quiz_date: string;
  completed_at: Date | string | null;
}

interface AnswerRow {
  sequence: number;
  question_revision_id: string;
  selected_index: number;
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
  explanation: string;
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

function applyChoiceOrder(
  choicesValue: unknown,
  orderValue: unknown,
): [string, string, string, string] {
  const choices = toChoiceTuple(choicesValue);
  if (
    !Array.isArray(orderValue) ||
    orderValue.length !== 4 ||
    orderValue.some(
      (index) =>
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 3,
    ) ||
    new Set(orderValue).size !== 4
  ) {
    throw new AppError({
      statusCode: 503,
      code: "CONTENT_INTEGRITY_ERROR",
      message: "오늘 문제를 준비하지 못했습니다.",
      retryable: true,
    });
  }

  const orderedChoices = orderValue.map(
    (index) => choices[index as 0 | 1 | 2 | 3],
  );
  return toChoiceTuple(orderedChoices);
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

export async function startDailyQuiz(
  database: Database,
  userId: string,
  now = new Date(),
): Promise<DailyStartResponse> {
  const quizDate = getKstDate(now);

  return database.client.begin(async (transaction) => {
    const items = await transaction<DailySetItemRow[]>`
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
      WHERE ds.quiz_date = ${quizDate}
        AND ds.status = 'published'
      ORDER BY dsi.position
    `;

    if (items.length !== 5 || items[0] === undefined) {
      throw new AppError({
        statusCode: 503,
        code: "DAILY_SET_NOT_READY",
        message: "오늘 문제를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
        retryable: true,
      });
    }

    const dailySetId = items[0].daily_set_id;
    let attempts = await transaction<AttemptRow[]>`
      SELECT
        a.id,
        a.user_id,
        a.status::text AS status,
        a.score::int AS score,
        ds.quiz_date::text AS quiz_date,
        a.completed_at
      FROM attempts a
      JOIN daily_sets ds ON ds.id = a.daily_set_id
      WHERE a.user_id = ${userId}
        AND a.daily_set_id = ${dailySetId}
      FOR UPDATE OF a
    `;
    let attempt = attempts[0];

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
        INSERT INTO attempts (user_id, daily_set_id)
        VALUES (${userId}, ${dailySetId})
        ON CONFLICT (user_id, daily_set_id) DO NOTHING
      `;
      attempts = await transaction<AttemptRow[]>`
        SELECT
          a.id,
          a.user_id,
          a.status::text AS status,
          a.score::int AS score,
          ds.quiz_date::text AS quiz_date,
          a.completed_at
        FROM attempts a
        JOIN daily_sets ds ON ds.id = a.daily_set_id
        WHERE a.user_id = ${userId}
          AND a.daily_set_id = ${dailySetId}
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

    if (
      attempt.status === "started" &&
      isPastDailyCompletionDeadline(attempt.quiz_date, now)
    ) {
      const abandoned = await transaction<AttemptRow[]>`
        UPDATE attempts
        SET status = 'abandoned', abandoned_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
        WHERE id = ${attempt.id} AND status = 'started'
        RETURNING
          id,
          user_id,
          status::text AS status,
          score::int AS score,
          ${attempt.quiz_date}::text AS quiz_date,
          completed_at
      `;
      attempt = abandoned[0] ?? attempt;
    }

    const answers = await transaction<AnswerRow[]>`
      SELECT
        sequence::int AS sequence,
        question_revision_id,
        selected_index::int AS selected_index
      FROM attempt_answers
      WHERE attempt_id = ${attempt.id}
      ORDER BY sequence
    `;

    return DailyStartResponseSchema.parse({
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
    });
  });
}

export async function submitAnswer(
  database: Database,
  userId: string,
  attemptId: string,
  idempotencyKey: string,
  answer: SubmitAnswerRequest,
  now = new Date(),
): Promise<SubmitAnswerResponse> {
  const operation = `answer:${attemptId}`;
  const keyHash = sha256(idempotencyKey);
  const requestHash = sha256(JSON.stringify(answer));

  const result = await database.client.begin(async (transaction) => {
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
      if (record === undefined) {
        throw new AppError({
          statusCode: 409,
          code: "REQUEST_IN_PROGRESS",
          message: "같은 요청을 처리하고 있습니다.",
          retryable: true,
        });
      }
      if (record.request_hash !== requestHash) {
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
        response: SubmitAnswerResponseSchema.parse(record.response_body),
      };
    }

    const attempts = await transaction<AttemptRow[]>`
      SELECT
        a.id,
        a.user_id,
        a.status::text AS status,
        a.score::int AS score,
        ds.quiz_date::text AS quiz_date,
        a.completed_at
      FROM attempts a
      JOIN daily_sets ds ON ds.id = a.daily_set_id
      WHERE a.id = ${attemptId}
      FOR UPDATE OF a
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
        message: "이 퀴즈에 답할 권한이 없습니다.",
      });
    }
    if (attempt.status === "completed") {
      throw new AppError({
        statusCode: 409,
        code: "ATTEMPT_ALREADY_COMPLETED",
        message: "이미 완료한 퀴즈입니다.",
      });
    }
    if (attempt.status === "abandoned") {
      throw new AppError({
        statusCode: 409,
        code: "ATTEMPT_ABANDONED",
        message: "완료 가능 시간이 지난 퀴즈입니다.",
      });
    }

    if (isPastDailyCompletionDeadline(attempt.quiz_date, now)) {
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

    const existingAnswer = await transaction`
      SELECT 1
      FROM attempt_answers
      WHERE attempt_id = ${attemptId}
        AND sequence = ${answer.sequence}
    `;
    if (existingAnswer.length > 0) {
      throw new AppError({
        statusCode: 422,
        code: "ANSWER_ALREADY_SUBMITTED",
        message: "이미 제출한 문항입니다.",
      });
    }

    const counts = await transaction<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM attempt_answers
      WHERE attempt_id = ${attemptId}
    `;
    const answeredCount = counts[0]?.count ?? 0;
    if (answer.sequence !== answeredCount + 1) {
      throw new AppError({
        statusCode: 422,
        code: "ANSWER_OUT_OF_ORDER",
        message: "문항을 순서대로 제출해 주세요.",
        details: { expectedSequence: answeredCount + 1 },
      });
    }

    const expected = await transaction<{ revision_id: string }[]>`
      SELECT dsi.question_revision_id AS revision_id
      FROM attempts a
      JOIN daily_set_items dsi ON dsi.daily_set_id = a.daily_set_id
      WHERE a.id = ${attemptId}
        AND dsi.position = ${answer.sequence}
    `;
    if (expected[0]?.revision_id !== answer.questionRevisionId) {
      throw new AppError({
        statusCode: 409,
        code: "QUESTION_REVISION_CONFLICT",
        message: "문제 버전이 현재 퀴즈와 일치하지 않습니다.",
      });
    }

    await transaction`
      INSERT INTO attempt_answers (
        attempt_id,
        sequence,
        question_revision_id,
        selected_index,
        received_at
      )
      VALUES (
        ${attemptId},
        ${answer.sequence},
        ${answer.questionRevisionId},
        ${answer.selectedIndex},
        ${now.toISOString()}
      )
    `;

    const response = SubmitAnswerResponseSchema.parse({
      attemptId,
      sequence: answer.sequence,
      saved: true,
      answeredCount: answeredCount + 1,
      nextSequence: answer.sequence === 5 ? null : answer.sequence + 1,
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

export async function completeAttempt(
  database: Database,
  userId: string,
  attemptId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<CompleteAttemptResponse> {
  const operation = `complete:${attemptId}`;
  const keyHash = sha256(idempotencyKey);
  const requestHash = sha256("{}");

  const result = await database.client.begin(async (transaction) => {
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

    const attempts = await transaction<AttemptRow[]>`
      SELECT
        a.id,
        a.user_id,
        a.status::text AS status,
        a.score::int AS score,
        ds.quiz_date::text AS quiz_date,
        a.completed_at
      FROM attempts a
      JOIN daily_sets ds ON ds.id = a.daily_set_id
      WHERE a.id = ${attemptId}
      FOR UPDATE OF a
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
    if (attempt.status === "abandoned") {
      throw new AppError({
        statusCode: 409,
        code: "ATTEMPT_ABANDONED",
        message: "완료 가능 시간이 지난 퀴즈입니다.",
      });
    }

    if (
      attempt.status === "started" &&
      isPastDailyCompletionDeadline(attempt.quiz_date, now)
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

    const reviewRows = await transaction<ReviewRow[]>`
      SELECT
        aa.sequence::int AS sequence,
        qr.prompt,
        aa.selected_index::int AS selected_index,
        qr.correct_index::int AS correct_index,
        qr.explanation
      FROM attempt_answers aa
      JOIN question_revisions qr ON qr.id = aa.question_revision_id
      WHERE aa.attempt_id = ${attemptId}
      ORDER BY aa.sequence
    `;

    if (reviewRows.length !== 5) {
      throw new AppError({
        statusCode: 422,
        code: "ANSWERS_INCOMPLETE",
        message: "5문제를 모두 제출한 뒤 완료해 주세요.",
        details: { answeredCount: reviewRows.length },
      });
    }

    let score = attempt.score;
    let completedAt = attempt.completed_at;

    if (attempt.status === "started") {
      score = reviewRows.filter(
        (row) => row.selected_index === row.correct_index,
      ).length;
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
      review: reviewRows.map((row) => ({
        sequence: row.sequence,
        prompt: row.prompt,
        selectedIndex: row.selected_index,
        correctIndex: row.correct_index,
        correct: row.selected_index === row.correct_index,
        explanation: row.explanation,
      })),
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
