import type { TransactionSql } from "postgres";
import type { Database } from "../db/client.js";

export const CLEANUP_BATCH_SIZE = 500;
export const EXPIRED_CHALLENGE_RETENTION_DAYS = 7;
export const CHALLENGE_RESULT_RETENTION_DAYS = 30;

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

type Transaction = TransactionSql<{}>;

interface CountRow {
  count: number;
}

export interface CleanupCounts {
  challengesExpired: number;
  challengesPurged: number;
  claimedChallengesRedacted: number;
  claimedChallengesPurged: number;
  completedChallengesRedacted: number;
  idempotencyRecordsDeleted: number;
}

function retentionCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_IN_MILLISECONDS).toISOString();
}

function count(rows: CountRow[]): number {
  return rows[0]?.count ?? 0;
}

async function expireOpenChallenges(
  transaction: Transaction,
  now: string,
): Promise<number> {
  const rows = await transaction<CountRow[]>`
    WITH candidates AS (
      SELECT id
      FROM challenges
      WHERE status = 'open'
        AND expires_at <= ${now}
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${CLEANUP_BATCH_SIZE}
    ), expired AS (
      UPDATE challenges AS challenge
      SET status = 'expired',
          updated_at = ${now}
      FROM candidates
      WHERE challenge.id = candidates.id
      RETURNING challenge.id
    )
    SELECT count(*)::integer AS count
    FROM expired
  `;

  return count(rows);
}

async function purgeExpiredChallenges(
  transaction: Transaction,
  cutoff: string,
): Promise<number> {
  const rows = await transaction<CountRow[]>`
    WITH candidates AS (
      SELECT challenge.id
      FROM challenges AS challenge
      WHERE challenge.status IN ('open', 'expired')
        AND challenge.expires_at <= ${cutoff}
      ORDER BY challenge.id
      FOR UPDATE OF challenge SKIP LOCKED
      LIMIT ${CLEANUP_BATCH_SIZE}
    ), deleted AS (
      DELETE FROM challenges AS challenge
      USING candidates
      WHERE challenge.id = candidates.id
      RETURNING challenge.id
    )
    SELECT count(*)::integer AS count
    FROM deleted
  `;

  return count(rows);
}

async function redactClaimedChallenges(
  transaction: Transaction,
  cutoff: string,
  now: string,
): Promise<number> {
  const rows = await transaction<CountRow[]>`
    WITH candidates AS (
      SELECT id
      FROM challenges
      WHERE status = 'claimed'
        AND expires_at <= ${cutoff}
        AND (
          creator_score IS NOT NULL
          OR creator_nickname_snapshot IS NOT NULL
          OR opponent_score IS NOT NULL
          OR opponent_nickname_snapshot IS NOT NULL
          OR result_redacted_at IS NULL
        )
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${CLEANUP_BATCH_SIZE}
    ), redacted AS (
      UPDATE challenges AS challenge
      SET creator_score = NULL,
          creator_nickname_snapshot = NULL,
          opponent_score = NULL,
          opponent_nickname_snapshot = NULL,
          result_redacted_at = COALESCE(challenge.result_redacted_at, ${now}),
          updated_at = ${now}
      FROM candidates
      WHERE challenge.id = candidates.id
      RETURNING challenge.id
    )
    SELECT count(*)::integer AS count
    FROM redacted
  `;

  return count(rows);
}

async function purgeClaimedChallenges(
  transaction: Transaction,
  cutoff: string,
): Promise<number> {
  const rows = await transaction<CountRow[]>`
    WITH candidates AS (
      SELECT challenge.id
      FROM challenges AS challenge
      WHERE challenge.status = 'claimed'
        AND challenge.expires_at <= ${cutoff}
        AND challenge.result_redacted_at IS NOT NULL
        AND challenge.creator_score IS NULL
        AND challenge.creator_nickname_snapshot IS NULL
        AND challenge.opponent_score IS NULL
        AND challenge.opponent_nickname_snapshot IS NULL
      ORDER BY challenge.id
      FOR UPDATE OF challenge SKIP LOCKED
      LIMIT ${CLEANUP_BATCH_SIZE}
    ), deleted AS (
      DELETE FROM challenges AS challenge
      USING candidates
      WHERE challenge.id = candidates.id
      RETURNING challenge.id
    )
    SELECT count(*)::integer AS count
    FROM deleted
  `;

  return count(rows);
}

async function redactCompletedChallenges(
  transaction: Transaction,
  cutoff: string,
  now: string,
): Promise<number> {
  const rows = await transaction<CountRow[]>`
    WITH candidates AS (
      SELECT id
      FROM challenges
      WHERE status = 'completed'
        AND completed_at <= ${cutoff}
        AND (
          creator_score IS NOT NULL
          OR creator_nickname_snapshot IS NOT NULL
          OR opponent_score IS NOT NULL
          OR opponent_nickname_snapshot IS NOT NULL
          OR result_redacted_at IS NULL
        )
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${CLEANUP_BATCH_SIZE}
    ), redacted AS (
      UPDATE challenges AS challenge
      SET creator_score = NULL,
          creator_nickname_snapshot = NULL,
          opponent_score = NULL,
          opponent_nickname_snapshot = NULL,
          result_redacted_at = COALESCE(challenge.result_redacted_at, ${now}),
          updated_at = ${now}
      FROM candidates
      WHERE challenge.id = candidates.id
      RETURNING challenge.id
    )
    SELECT count(*)::integer AS count
    FROM redacted
  `;

  return count(rows);
}

async function deleteExpiredIdempotencyRecords(
  transaction: Transaction,
  now: string,
): Promise<number> {
  const rows = await transaction<CountRow[]>`
    WITH candidates AS (
      SELECT id
      FROM idempotency_records
      WHERE expires_at <= ${now}
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${CLEANUP_BATCH_SIZE}
    ), deleted AS (
      DELETE FROM idempotency_records AS record
      USING candidates
      WHERE record.id = candidates.id
      RETURNING record.id
    )
    SELECT count(*)::integer AS count
    FROM deleted
  `;

  return count(rows);
}

export async function runCleanup(
  database: Database,
  now: Date,
): Promise<CleanupCounts> {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Cleanup time must be a valid Date");
  }

  const expiredChallengeCutoff = retentionCutoff(
    now,
    EXPIRED_CHALLENGE_RETENTION_DAYS,
  );
  const challengeResultCutoff = retentionCutoff(
    now,
    CHALLENGE_RESULT_RETENTION_DAYS,
  );
  const currentTimestamp = now.toISOString();

  return database.client.begin(async (transaction) => ({
    challengesExpired: await expireOpenChallenges(
      transaction,
      currentTimestamp,
    ),
    challengesPurged: await purgeExpiredChallenges(
      transaction,
      expiredChallengeCutoff,
    ),
    claimedChallengesRedacted: await redactClaimedChallenges(
      transaction,
      challengeResultCutoff,
      currentTimestamp,
    ),
    claimedChallengesPurged: await purgeClaimedChallenges(
      transaction,
      challengeResultCutoff,
    ),
    completedChallengesRedacted: await redactCompletedChallenges(
      transaction,
      challengeResultCutoff,
      currentTimestamp,
    ),
    idempotencyRecordsDeleted: await deleteExpiredIdempotencyRecords(
      transaction,
      currentTimestamp,
    ),
  }));
}
