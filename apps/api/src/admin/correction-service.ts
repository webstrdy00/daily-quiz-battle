import {
  AdminVoidDailySetResponseSchema,
  ChoiceOrderSchema,
  UuidSchema,
  type AdminVoidDailySetRequest,
  type AdminVoidDailySetResponse,
} from "@daily-quiz-battle/contracts";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { AppError, parseRequest } from "../shared/errors.js";

export interface CorrectFutureDailySetRequest {
  expectedVersion: number;
  reason: string;
  items: readonly {
    revisionId: string;
    choiceOrder: readonly [number, number, number, number];
  }[];
}

export interface CorrectFutureDailySetResponse {
  id: string;
  version: number;
}

const FutureDailySetCorrectionSchema = z
  .object({
    expectedVersion: z.number().int().positive().max(2_147_483_646),
    reason: z.string().trim().min(1).max(500),
    items: z
      .array(
        z
          .object({ revisionId: UuidSchema, choiceOrder: ChoiceOrderSchema })
          .strict(),
      )
      .length(5),
  })
  .strict();

const CORRECTION_ERRORS: Record<string, number> = {
  DAILY_SET_NOT_FOUND: 404,
  DAILY_SET_NOT_PUBLISHED: 409,
  DAILY_SET_NOT_FUTURE: 409,
  DAILY_SET_ALREADY_VOIDED: 409,
  DAILY_SET_ALREADY_PLAYED: 409,
  DAILY_SET_ALREADY_CHALLENGED: 409,
  DAILY_SET_VERSION_CONFLICT: 409,
  DAILY_SET_ITEM_COUNT_INVALID: 422,
  DAILY_SET_REVISIONS_NOT_DISTINCT: 422,
  DAILY_SET_REVISION_INTEGRITY_ERROR: 422,
  DAILY_SET_REVISION_NOT_PUBLISHED: 422,
  DAILY_SET_LOGICAL_QUESTIONS_NOT_DISTINCT: 422,
  DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID: 422,
  DAILY_SET_CATEGORY_LIMIT_EXCEEDED: 422,
  DAILY_SET_REVISION_VALIDITY_EXPIRED: 422,
  DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED: 422,
  DAILY_SET_CORRECTION_NO_CHANGE: 422,
  INVALID_REQUEST: 400,
};

/** The database function owns validation, authorization, switching and audit. */
export async function correctFutureDailySet(
  database: Database,
  actorSubject: string,
  dailySetId: string,
  request: CorrectFutureDailySetRequest,
  now = new Date(),
): Promise<CorrectFutureDailySetResponse> {
  const parsed = parseRequest(FutureDailySetCorrectionSchema, request);
  const actor = parseRequest(z.string().trim().min(1).max(100), actorSubject);
  const id = parseRequest(UuidSchema, dailySetId);
  const correctedAt = toIsoDateTime(now);

  try {
    return await database.client.begin(async (transaction) => {
      const rows = await transaction<CorrectFutureDailySetResponse[]>`
        SELECT id, version
        FROM public.correct_future_daily_set(
          ${id}::uuid,
          ${parsed.expectedVersion}::integer,
          ${actor}::text,
          ${parsed.reason}::text,
          ${JSON.stringify(parsed.items)}::jsonb,
          ${correctedAt}::timestamptz
        )
      `;
      const result = rows[0];
      if (result === undefined) {
        throw new AppError({
          statusCode: 500,
          code: "CONTENT_DATA_INTEGRITY_ERROR",
          message: "콘텐츠 변경 결과를 불러오지 못했습니다.",
        });
      }
      return result;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "P0001" &&
      Object.hasOwn(CORRECTION_ERRORS, error.message)
    ) {
      throw new AppError({
        statusCode: CORRECTION_ERRORS[error.message]!,
        code: error.message,
        message: "데일리 세트 정정 조건을 충족하지 못했습니다.",
      });
    }
    throw error;
  }
}

interface DailySetRow {
  id: string;
  published_at: Date | string | null;
}

interface DailySetVoidRow {
  actor_subject: string;
  reason: string;
  voided_at: Date | string;
}

function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      statusCode: 500,
      code: "CONTENT_DATA_INTEGRITY_ERROR",
      message: "콘텐츠 변경 결과를 불러오지 못했습니다.",
    });
  }
  return date.toISOString();
}

export async function voidDailySet(
  database: Database,
  actorSubject: string,
  dailySetId: string,
  request: AdminVoidDailySetRequest,
  now = new Date(),
): Promise<AdminVoidDailySetResponse> {
  const reason = request.reason.trim();

  return database.client.begin(async (transaction) => {
    const sets = await transaction<DailySetRow[]>`
      SELECT id, published_at
      FROM daily_sets
      WHERE id = ${dailySetId}
      FOR UPDATE
    `;
    const dailySet = sets[0];
    if (dailySet === undefined) {
      throw new AppError({
        statusCode: 404,
        code: "DAILY_SET_NOT_FOUND",
        message: "데일리 세트를 찾을 수 없습니다.",
      });
    }
    if (dailySet.published_at === null) {
      throw new AppError({
        statusCode: 409,
        code: "DAILY_SET_NOT_PUBLISHED",
        message: "게시된 적이 있는 데일리 세트만 무효 처리할 수 있습니다.",
      });
    }

    const existingRows = await transaction<DailySetVoidRow[]>`
      SELECT actor_subject, reason, voided_at
      FROM daily_set_voids
      WHERE daily_set_id = ${dailySetId}
    `;
    const existing = existingRows[0];
    if (existing !== undefined) {
      if (existing.reason !== reason) {
        throw new AppError({
          statusCode: 409,
          code: "DAILY_SET_ALREADY_VOIDED",
          message: "이미 다른 사유로 무효 처리된 데일리 세트입니다.",
        });
      }

      return AdminVoidDailySetResponseSchema.parse({
        dailySetId,
        void: {
          actorSubject: existing.actor_subject,
          reason: existing.reason,
          voidedAt: toIsoDateTime(existing.voided_at),
        },
        replayed: true,
      });
    }

    const voidedAt = toIsoDateTime(now);
    await transaction`
      INSERT INTO daily_set_voids (
        daily_set_id,
        actor_subject,
        reason,
        voided_at
      )
      VALUES (
        ${dailySetId},
        ${actorSubject},
        ${reason},
        ${voidedAt}
      )
    `;

    await transaction`
      UPDATE notification_outbox
      SET status = 'failed', last_error = 'daily_set_voided'
      WHERE status = 'pending'
        AND challenge_id IN (
          SELECT id
          FROM challenges
          WHERE daily_set_id = ${dailySetId}
        )
    `;

    const action = "daily_set.void";
    await transaction`
      INSERT INTO admin_audit_logs (
        actor_subject,
        action,
        resource_type,
        resource_id,
        metadata
      )
      VALUES (
        ${actorSubject},
        ${action},
        'daily_set',
        ${dailySetId},
        ${JSON.stringify({ action, reason })}::jsonb
      )
    `;

    return AdminVoidDailySetResponseSchema.parse({
      dailySetId,
      void: {
        actorSubject,
        reason,
        voidedAt,
      },
      replayed: false,
    });
  });
}
