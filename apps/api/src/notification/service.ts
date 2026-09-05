import { timingSafeEqual } from "node:crypto";
import {
  ResultNotificationPreferenceResponseSchema,
  type ResultNotificationPreferenceResponse,
  type UpdateResultNotificationPreferenceRequest,
} from "@daily-quiz-battle/contracts";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";
import { fingerprintAnonymousKey } from "../shared/hash.js";
import type {
  EncryptedNotificationTarget,
  NotificationTargetCrypto,
} from "./target-crypto.js";

interface LockedUserRow {
  anonymous_key_fingerprint: string;
  identity_status: "active" | "deleted" | "blocked";
}

interface PreferenceRow {
  result_enabled: boolean;
  updated_at: Date | string;
}

function fingerprintsEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return (
    expectedBytes.byteLength === actualBytes.byteLength &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function unavailableAuthentication(): AppError {
  return new AppError({
    statusCode: 401,
    code: "UNAUTHORIZED",
    message: "현재 사용할 수 없는 인증입니다.",
  });
}

function identityMismatch(): AppError {
  return new AppError({
    statusCode: 403,
    code: "IDENTITY_MISMATCH",
    message: "인증된 사용자 정보와 일치하지 않습니다.",
  });
}

function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      statusCode: 500,
      code: "DATA_INTEGRITY_ERROR",
      message: "알림 설정을 불러오지 못했습니다.",
    });
  }
  return date.toISOString();
}

export async function getResultNotificationPreference(
  database: Database,
  userId: string,
  now = new Date(),
): Promise<ResultNotificationPreferenceResponse> {
  const rows = await database.client<PreferenceRow[]>`
    SELECT result_enabled, updated_at
    FROM notification_preferences
    WHERE user_id = ${userId}
  `;
  const preference = rows[0];

  return ResultNotificationPreferenceResponseSchema.parse({
    enabled: preference?.result_enabled ?? false,
    updatedAt: toIsoDateTime(preference?.updated_at ?? now),
  });
}

export async function updateResultNotificationPreference(
  database: Database,
  targetCrypto: NotificationTargetCrypto,
  anonymousKeyPepper: string,
  userId: string,
  preference: UpdateResultNotificationPreferenceRequest,
  now = new Date(),
): Promise<ResultNotificationPreferenceResponse> {
  return database.client.begin(async (transaction) => {
    const users = await transaction<LockedUserRow[]>`
      SELECT anon_key_fingerprint AS anonymous_key_fingerprint, identity_status
      FROM users
      WHERE id = ${userId}
      FOR UPDATE
    `;
    const user = users[0];

    if (user === undefined || user.identity_status !== "active") {
      throw unavailableAuthentication();
    }

    const suppliedFingerprint = fingerprintAnonymousKey(
      preference.anonymousKey,
      anonymousKeyPepper,
    );
    if (
      !fingerprintsEqual(user.anonymous_key_fingerprint, suppliedFingerprint)
    ) {
      throw identityMismatch();
    }

    await transaction`
      SELECT id
      FROM notification_outbox
      WHERE recipient_user_id = ${userId}
        AND status = 'pending'
      ORDER BY id
      FOR UPDATE
    `;

    const encryptedTarget: EncryptedNotificationTarget | undefined =
      preference.enabled
        ? targetCrypto.encrypt(userId, preference.anonymousKey)
        : undefined;
    const updatedAt = now.toISOString();
    const rows = await transaction<PreferenceRow[]>`
      INSERT INTO notification_preferences (
        user_id,
        result_enabled,
        encrypted_anon_key,
        iv,
        auth_tag,
        key_version,
        agreed_at,
        revoked_at,
        updated_at
      )
      VALUES (
        ${userId},
        ${preference.enabled},
        ${encryptedTarget?.encryptedAnonymousKey ?? null},
        ${encryptedTarget?.iv ?? null},
        ${encryptedTarget?.authTag ?? null},
        ${encryptedTarget?.keyVersion ?? null},
        ${preference.enabled ? updatedAt : null},
        ${preference.enabled ? null : updatedAt},
        ${updatedAt}
      )
      ON CONFLICT (user_id) DO UPDATE
      SET result_enabled = EXCLUDED.result_enabled,
          encrypted_anon_key = EXCLUDED.encrypted_anon_key,
          iv = EXCLUDED.iv,
          auth_tag = EXCLUDED.auth_tag,
          key_version = EXCLUDED.key_version,
          agreed_at = EXCLUDED.agreed_at,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = EXCLUDED.updated_at
      RETURNING result_enabled, updated_at
    `;
    const savedPreference = rows[0];

    if (savedPreference === undefined) {
      throw new AppError({
        statusCode: 500,
        code: "PREFERENCE_UPDATE_FAILED",
        message: "알림 설정을 저장하지 못했습니다.",
      });
    }

    return ResultNotificationPreferenceResponseSchema.parse({
      enabled: savedPreference.result_enabled,
      updatedAt: toIsoDateTime(savedPreference.updated_at),
    });
  });
}
