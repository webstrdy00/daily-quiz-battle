import { createHash, randomBytes } from "node:crypto";
import {
  DeleteAccountResponseSchema,
  type DeleteAccountResponse,
} from "@daily-quiz-battle/contracts";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";

interface LockedUserRow {
  identity_status: "active" | "deleted" | "blocked";
}

function replacementFingerprint(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

function unavailableAuthentication(): AppError {
  return new AppError({
    statusCode: 401,
    code: "UNAUTHORIZED",
    message: "현재 사용할 수 없는 인증입니다.",
  });
}

export async function deleteAccount(
  database: Database,
  userId: string,
  now = new Date(),
): Promise<DeleteAccountResponse> {
  const deletedAt = now.toISOString();
  const anonymousFingerprint = replacementFingerprint();

  return database.client.begin(async (transaction) => {
    const users = await transaction<LockedUserRow[]>`
      SELECT identity_status
      FROM users
      WHERE id = ${userId}
      FOR UPDATE
    `;
    const user = users[0];

    if (user === undefined || user.identity_status !== "active") {
      throw unavailableAuthentication();
    }

    await transaction`
      SELECT set_config('app.account_deletion_user_id', ${userId}, true)
    `;

    // Lock every affected challenge in a stable order before mutating any of
    // them. The opposite participant's snapshots remain intact; the result
    // endpoint's redacted response only exposes the authenticated viewer side.
    await transaction`
      SELECT id
      FROM challenges
      WHERE creator_user_id = ${userId}
         OR claimed_by_user_id = ${userId}
      ORDER BY id
      FOR UPDATE
    `;

    await transaction`
      UPDATE challenges
      SET creator_score = CASE
            WHEN creator_user_id = ${userId} THEN NULL
            ELSE creator_score
          END,
          creator_nickname_snapshot = CASE
            WHEN creator_user_id = ${userId} THEN NULL
            ELSE creator_nickname_snapshot
          END,
          opponent_score = CASE
            WHEN claimed_by_user_id = ${userId} THEN NULL
            ELSE opponent_score
          END,
          opponent_nickname_snapshot = CASE
            WHEN claimed_by_user_id = ${userId} THEN NULL
            ELSE opponent_nickname_snapshot
          END,
          status = CASE
            WHEN status = 'open' THEN 'expired'::challenge_status
            ELSE status
          END,
          result_redacted_at = ${deletedAt},
          updated_at = ${deletedAt}
      WHERE creator_user_id = ${userId}
         OR claimed_by_user_id = ${userId}
    `;

    // Redaction must precede deleting attempts because their challenge foreign
    // keys are cleared by ON DELETE SET NULL.
    await transaction`
      DELETE FROM attempt_answers
      WHERE attempt_id IN (
        SELECT id
        FROM attempts
        WHERE user_id = ${userId}
      )
    `;
    await transaction`
      DELETE FROM attempts
      WHERE user_id = ${userId}
    `;
    await transaction`
      DELETE FROM reports
      WHERE reporter_user_id = ${userId}
    `;
    await transaction`
      DELETE FROM idempotency_records
      WHERE user_id = ${userId}
    `;
    await transaction`
      DELETE FROM notification_outbox
      WHERE recipient_user_id = ${userId}
    `;
    await transaction`
      DELETE FROM notification_preferences
      WHERE user_id = ${userId}
    `;

    await transaction`
      UPDATE users
      SET identity_status = 'deleted',
          deleted_at = ${deletedAt},
          nickname = '탈퇴한 사용자',
          anon_key_fingerprint = ${anonymousFingerprint},
          token_version = token_version + 1,
          streak_days = 0,
          last_daily_date = NULL,
          updated_at = ${deletedAt}
      WHERE id = ${userId}
    `;

    return DeleteAccountResponseSchema.parse({
      status: "deleted",
      deletedAt,
    });
  });
}
