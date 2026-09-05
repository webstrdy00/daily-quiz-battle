import {
  AdminVoidDailySetResponseSchema,
  type AdminVoidDailySetRequest,
  type AdminVoidDailySetResponse,
} from "@daily-quiz-battle/contracts";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";

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
