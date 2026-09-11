import type { TransactionSql } from "postgres";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";
import type { NotificationSender } from "./sender.js";

const MAX_ATTEMPTS = 10;
const DEFAULT_BATCH_SIZE = 50;

type Transaction = TransactionSql<{}>;

interface PendingNotificationRow {
  id: string;
  event_type: "challenge.completed";
  recipient_user_id: string;
  challenge_id: string;
  attempt_count: number;
  identity_status: "active" | "deleted" | "blocked" | null;
  result_enabled: boolean | null;
  encrypted_anon_key: Buffer | null;
  iv: Buffer | null;
  auth_tag: Buffer | null;
  key_version: number | null;
  revoked_at: Date | string | null;
  existing_challenge_id: string | null;
  public_token_hash: string | null;
  creator_user_id: string | null;
  challenge_status: "open" | "claimed" | "completed" | "expired" | null;
  result_redacted_at: Date | string | null;
  voided_at: Date | string | null;
}

export interface NotificationWorkerCounts {
  published: number;
  retried: number;
  failed: number;
  skipped: number;
}

export interface NotificationWorkerOptions {
  batchSize?: number;
  now?: Date;
}

export async function enqueueChallengeCompletionNotifications(
  transaction: Transaction,
  challengeIds: readonly string[],
  enabled = true,
): Promise<void> {
  if (!enabled || challengeIds.length === 0) {
    return;
  }

  await transaction`
    INSERT INTO notification_outbox (
      event_type,
      recipient_user_id,
      challenge_id,
      dedupe_key,
      occurred_at
    )
    SELECT
      'challenge.completed',
      c.creator_user_id,
      c.id,
      'challenge.completed:' || c.id::text,
      c.completed_at
    FROM challenges c
    JOIN users u ON u.id = c.creator_user_id
    JOIN notification_preferences p ON p.user_id = c.creator_user_id
    WHERE c.id IN ${transaction([...new Set(challengeIds)])}
      AND c.status = 'completed'
      AND c.completed_at IS NOT NULL
      AND c.result_redacted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM daily_set_voids dsv
        WHERE dsv.daily_set_id = c.daily_set_id
      )
      AND u.identity_status = 'active'
      AND p.result_enabled
      AND p.revoked_at IS NULL
    ON CONFLICT (dedupe_key) DO NOTHING
  `;
}

function isEligible(row: PendingNotificationRow): boolean {
  return (
    row.event_type === "challenge.completed" &&
    row.identity_status === "active" &&
    row.result_enabled === true &&
    row.revoked_at === null &&
    row.encrypted_anon_key !== null &&
    row.iv !== null &&
    row.auth_tag !== null &&
    row.key_version !== null &&
    row.existing_challenge_id !== null &&
    row.public_token_hash !== null &&
    row.creator_user_id === row.recipient_user_id &&
    row.challenge_status === "completed" &&
    row.result_redacted_at === null &&
    row.voided_at === null
  );
}

function nextAvailableAt(now: Date, attemptCount: number): Date {
  const delayMilliseconds = 60_000 * 2 ** (attemptCount - 1);
  return new Date(now.getTime() + delayMilliseconds);
}

type LastErrorReason =
  | "challenge_token_invalid"
  | "configuration_invalid"
  | "delivery_failed"
  | "delivery_rejected"
  | "recipient_ineligible"
  | "target_invalid";

const APP_ERROR_REASONS: Readonly<Record<string, LastErrorReason>> = {
  NOTIFICATION_CHALLENGE_TOKEN_INVALID: "challenge_token_invalid",
  NOTIFICATION_CONFIGURATION_INVALID: "configuration_invalid",
  NOTIFICATION_DELIVERY_REJECTED: "delivery_rejected",
  NOTIFICATION_DELIVERY_UNAVAILABLE: "delivery_failed",
  NOTIFICATION_TARGET_INVALID: "target_invalid",
};

function classifyDeliveryError(error: unknown): {
  retryable: boolean;
  reason: LastErrorReason;
} {
  if (!(error instanceof AppError)) {
    return { retryable: true, reason: "delivery_failed" };
  }

  return {
    retryable: error.retryable,
    reason:
      APP_ERROR_REASONS[error.code] ??
      (error.retryable ? "delivery_failed" : "delivery_rejected"),
  };
}

export async function runNotificationWorker(
  database: Database,
  sender: NotificationSender,
  options: NotificationWorkerOptions = {},
): Promise<NotificationWorkerCounts> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = options.now ?? new Date();

  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("Notification worker batch size must be positive");
  }

  return database.client.begin(async (transaction) => {
    const rows = await transaction<PendingNotificationRow[]>`
      SELECT
        o.id,
        o.event_type::text AS event_type,
        o.recipient_user_id,
        o.challenge_id,
        o.attempt_count::int AS attempt_count,
        u.identity_status::text AS identity_status,
        p.result_enabled,
        p.encrypted_anon_key,
        p.iv,
        p.auth_tag,
        p.key_version,
        p.revoked_at,
        c.id AS existing_challenge_id,
        c.public_token_hash,
        c.creator_user_id,
        c.status::text AS challenge_status,
        c.result_redacted_at,
        dsv.voided_at
      FROM notification_outbox o
      LEFT JOIN users u ON u.id = o.recipient_user_id
      LEFT JOIN notification_preferences p ON p.user_id = o.recipient_user_id
      LEFT JOIN challenges c ON c.id = o.challenge_id
      LEFT JOIN daily_set_voids dsv ON dsv.daily_set_id = c.daily_set_id
      WHERE o.status = 'pending'
        AND o.available_at <= ${now.toISOString()}
      ORDER BY o.occurred_at, o.id
      LIMIT ${batchSize}
      FOR UPDATE OF o SKIP LOCKED
    `;

    const counts: NotificationWorkerCounts = {
      published: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
    };

    for (const row of rows) {
      if (row.voided_at !== null) {
        await transaction`
          UPDATE notification_outbox
          SET status = 'failed', last_error = 'daily_set_voided'
          WHERE id = ${row.id}
        `;
        counts.skipped += 1;
        continue;
      }

      if (row.attempt_count >= MAX_ATTEMPTS) {
        await transaction`
          UPDATE notification_outbox
          SET status = 'failed', last_error = 'delivery_failed'
          WHERE id = ${row.id}
        `;
        counts.failed += 1;
        continue;
      }

      if (!isEligible(row)) {
        await transaction`
          UPDATE notification_outbox
          SET status = 'failed', last_error = 'recipient_ineligible'
          WHERE id = ${row.id}
        `;
        counts.skipped += 1;
        continue;
      }

      try {
        await sender.send({
          userId: row.recipient_user_id,
          challengeId: row.challenge_id,
          challengeTokenHash: row.public_token_hash!,
          target: {
            encryptedAnonymousKey: row.encrypted_anon_key!,
            iv: row.iv!,
            authTag: row.auth_tag!,
            keyVersion: row.key_version!,
          },
        });
        await transaction`
          UPDATE notification_outbox
          SET
            status = 'published',
            published_at = ${now.toISOString()},
            last_error = NULL
          WHERE id = ${row.id}
        `;
        counts.published += 1;
      } catch (error) {
        const attemptCount = row.attempt_count + 1;
        const failure = classifyDeliveryError(error);
        if (!failure.retryable || attemptCount >= MAX_ATTEMPTS) {
          await transaction`
            UPDATE notification_outbox
            SET
              status = 'failed',
              attempt_count = ${attemptCount},
              last_error = ${failure.reason}
            WHERE id = ${row.id}
          `;
          counts.failed += 1;
        } else {
          await transaction`
            UPDATE notification_outbox
            SET
              attempt_count = ${attemptCount},
              last_error = ${failure.reason},
              available_at = ${nextAvailableAt(now, attemptCount).toISOString()}
            WHERE id = ${row.id}
          `;
          counts.retried += 1;
        }
      }
    }

    return counts;
  });
}
