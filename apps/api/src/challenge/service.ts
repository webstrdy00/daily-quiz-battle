import {
  ChallengeLandingResponseSchema,
  ChallengeResultResponseSchema,
  ClaimChallengeResponseSchema,
  CreateChallengeResponseSchema,
  type ChallengeLandingResponse,
  type ChallengeResultResponse,
  type ClaimChallengeResponse,
  type CreateChallengeResponse,
} from "@daily-quiz-battle/contracts";
import { startOrResumeAttempt, type Transaction } from "../daily/service.js";
import type { Database } from "../db/client.js";
import { enqueueChallengeCompletionNotifications } from "../notification/outbox.js";
import { AppError } from "../shared/errors.js";
import { sha256 } from "../shared/hash.js";
import { getChallengeExpiry } from "../shared/time.js";
import type { ChallengeTokenService } from "./token.js";

const MAX_ACTIVE_CHALLENGES_PER_ATTEMPT = 5;

interface ChallengeRow {
  id: string;
  public_token_hash: string;
  daily_set_id: string;
  quiz_date: string;
  creator_user_id: string | null;
  creator_attempt_id: string | null;
  creator_score: number | null;
  creator_nickname_snapshot: string | null;
  claimed_by_user_id: string | null;
  opponent_attempt_id: string | null;
  opponent_score: number | null;
  opponent_nickname_snapshot: string | null;
  status: "open" | "claimed" | "completed" | "expired";
  expires_at: Date | string;
  completed_at: Date | string | null;
  result_redacted_at: Date | string | null;
}

interface IdempotencyRow {
  request_hash: string;
  status: "processing" | "completed";
  response_body: unknown;
  resource_id: string | null;
}

interface CreatorAttemptRow {
  id: string;
  user_id: string;
  daily_set_id: string;
  quiz_date: string;
  status: "started" | "completed" | "abandoned";
  score: number | null;
  nickname: string;
}

interface UserRow {
  id: string;
  nickname: string;
  identity_status: "active" | "deleted" | "blocked";
}

interface DailySetVoidRow {
  voided_at: Date | string;
}

interface DailySetVoidJoinRow {
  voided_at: Date | string | null;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      statusCode: 500,
      code: "DATA_INTEGRITY_ERROR",
      message: "도전 정보를 불러오지 못했습니다.",
    });
  }
  return date.toISOString();
}

function notFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: "CHALLENGE_NOT_FOUND",
    message: "도전을 찾을 수 없거나 만료되었습니다.",
  });
}

function isExpired(row: ChallengeRow, now: Date): boolean {
  return now >= new Date(toIso(row.expires_at));
}

function dailySetVoidedError(
  quizDate: string,
  voidedAt: Date | string,
): AppError {
  return new AppError({
    statusCode: 409,
    code: "DAILY_SET_VOIDED",
    message: "운영 검토로 이 날짜의 퀴즈 결과가 무효 처리되었습니다.",
    retryable: false,
    details: { quizDate, voidedAt: toIso(voidedAt) },
  });
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

async function lockDailySetAndLoadVoid(
  transaction: Transaction,
  dailySetId: string,
): Promise<DailySetVoidRow | undefined> {
  const rows = await transaction<DailySetVoidJoinRow[]>`
    SELECT dsv.voided_at
    FROM daily_sets ds
    LEFT JOIN daily_set_voids dsv ON dsv.daily_set_id = ds.id
    WHERE ds.id = ${dailySetId}
    FOR SHARE OF ds
  `;
  const row = rows[0];
  return row === undefined || row.voided_at === null
    ? undefined
    : { voided_at: row.voided_at };
}

async function lockChallengeByHash(
  transaction: Transaction,
  tokenHash: string,
): Promise<ChallengeRow | undefined> {
  const rows = await transaction<ChallengeRow[]>`
    SELECT
      c.id,
      c.public_token_hash,
      c.daily_set_id,
      ds.quiz_date::text AS quiz_date,
      c.creator_user_id,
      c.creator_attempt_id,
      c.creator_score::int AS creator_score,
      c.creator_nickname_snapshot,
      c.claimed_by_user_id,
      c.opponent_attempt_id,
      c.opponent_score::int AS opponent_score,
      c.opponent_nickname_snapshot,
      c.status::text AS status,
      c.expires_at,
      c.completed_at,
      c.result_redacted_at
    FROM challenges c
    JOIN daily_sets ds ON ds.id = c.daily_set_id
    WHERE c.public_token_hash = ${tokenHash}
    FOR UPDATE OF c
  `;
  return rows[0];
}

/**
 * Lazily flip an open challenge that passed expires_at to `expired` so
 * status reads are consistent without a background job. Returns the row
 * as it should be seen by the caller.
 */
async function reconcileExpiry(
  transaction: Transaction,
  row: ChallengeRow,
  now: Date,
): Promise<ChallengeRow> {
  if (row.status !== "open" || !isExpired(row, now)) {
    return row;
  }
  await transaction`
    UPDATE challenges
    SET status = 'expired', updated_at = ${now.toISOString()}
    WHERE id = ${row.id} AND status = 'open'
  `;
  return { ...row, status: "expired" };
}

async function loadUser(
  transaction: Transaction,
  userId: string,
): Promise<UserRow> {
  const rows = await transaction<UserRow[]>`
    SELECT id, nickname, identity_status::text AS identity_status
    FROM users
    WHERE id = ${userId}
    FOR UPDATE
  `;
  const user = rows[0];
  if (user === undefined || user.identity_status !== "active") {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "현재 사용할 수 없는 계정입니다.",
    });
  }
  return user;
}

// ---------------------------------------------------------------------------
// POST /v1/challenges
// ---------------------------------------------------------------------------

export async function createChallenge(
  database: Database,
  tokens: ChallengeTokenService,
  userId: string,
  attemptId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<CreateChallengeResponse> {
  const operation = "challenge:create";
  const keyHash = sha256(idempotencyKey);
  const requestHash = sha256(JSON.stringify({ attemptId }));

  const result = await database.client.begin(async (transaction) => {
    await loadUser(transaction, userId);

    const inserted = await transaction`
      INSERT INTO idempotency_records (
        user_id, operation, key_hash, request_hash, expires_at
      )
      VALUES (
        ${userId}, ${operation}, ${keyHash}, ${requestHash},
        ${now.toISOString()}::timestamptz + interval '72 hours'
      )
      ON CONFLICT (user_id, operation, key_hash) DO NOTHING
      RETURNING id
    `;

    if (inserted.length === 0) {
      const existing = await transaction<IdempotencyRow[]>`
        SELECT request_hash, status::text AS status, response_body, resource_id
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
      if (
        record.status !== "completed" ||
        record.response_body === null ||
        record.resource_id === null
      ) {
        throw new AppError({
          statusCode: 409,
          code: "REQUEST_IN_PROGRESS",
          message: "같은 요청을 처리하고 있습니다.",
          retryable: true,
        });
      }
      // ADR-0003: token is never stored; re-derive from the challenge id.
      const challengeRows = await transaction<
        {
          public_token_hash: string;
          quiz_date: string;
          voided_at: Date | string | null;
        }[]
      >`
        SELECT
          c.public_token_hash,
          ds.quiz_date::text AS quiz_date,
          dsv.voided_at
        FROM challenges c
        JOIN daily_sets ds ON ds.id = c.daily_set_id
        LEFT JOIN daily_set_voids dsv ON dsv.daily_set_id = c.daily_set_id
        WHERE c.id = ${record.resource_id}
        FOR SHARE OF ds
      `;
      const challenge = challengeRows[0];
      if (challenge !== undefined && challenge.voided_at !== null) {
        throw dailySetVoidedError(challenge.quiz_date, challenge.voided_at);
      }
      const storedHash = challenge?.public_token_hash;
      const token =
        storedHash === undefined
          ? null
          : tokens.deriveMatching(record.resource_id, storedHash);
      if (token === null) {
        throw new AppError({
          statusCode: 409,
          code: "CHALLENGE_TOKEN_UNAVAILABLE",
          message: "이전에 만든 도전 링크를 다시 불러올 수 없습니다.",
        });
      }
      const body = record.response_body as {
        challenge: Record<string, unknown>;
      };
      return {
        response: CreateChallengeResponseSchema.parse({
          challenge: { ...body.challenge, token },
        }),
      };
    }

    const attempts = await transaction<CreatorAttemptRow[]>`
      SELECT
        a.id,
        a.user_id,
        a.daily_set_id,
        ds.quiz_date::text AS quiz_date,
        a.status::text AS status,
        a.score::int AS score,
        u.nickname
      FROM attempts a
      JOIN daily_sets ds ON ds.id = a.daily_set_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = ${attemptId}
      FOR UPDATE OF a
      FOR SHARE OF ds
    `;
    const attempt = attempts[0];
    if (attempt === undefined || attempt.user_id !== userId) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "이 퀴즈로 도전을 만들 권한이 없습니다.",
      });
    }

    const dailySetVoid = await loadDailySetVoid(
      transaction,
      attempt.daily_set_id,
    );
    if (dailySetVoid !== undefined) {
      throw dailySetVoidedError(attempt.quiz_date, dailySetVoid.voided_at);
    }

    if (attempt.status !== "completed" || attempt.score === null) {
      throw new AppError({
        statusCode: 422,
        code: "ATTEMPT_NOT_COMPLETED",
        message: "퀴즈를 완료한 뒤 도전을 만들 수 있습니다.",
      });
    }

    // Claimed rows keep their status and result data after expiry (ADR-0003),
    // but expiry still removes both open and claimed rows from the active quota.
    const counts = await transaction<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM challenges
      WHERE creator_attempt_id = ${attemptId}
        AND status IN ('open', 'claimed')
        AND expires_at > ${now.toISOString()}
    `;
    if ((counts[0]?.count ?? 0) >= MAX_ACTIVE_CHALLENGES_PER_ATTEMPT) {
      throw new AppError({
        statusCode: 422,
        code: "CHALLENGE_LIMIT_REACHED",
        message: "진행 중인 도전은 최대 5개까지 만들 수 있습니다.",
        details: { limit: MAX_ACTIVE_CHALLENGES_PER_ATTEMPT },
      });
    }

    const expiresAt = getChallengeExpiry(now);
    const idRows = await transaction<{ id: string }[]>`
      SELECT gen_random_uuid() AS id
    `;
    const challengeId = idRows[0]!.id;
    const token = tokens.derive(challengeId);

    await transaction`
      INSERT INTO challenges (
        id,
        public_token_hash,
        daily_set_id,
        creator_user_id,
        creator_attempt_id,
        creator_score,
        creator_nickname_snapshot,
        status,
        expires_at,
        created_at,
        updated_at
      )
      VALUES (
        ${challengeId},
        ${tokens.hash(token)},
        ${attempt.daily_set_id},
        ${userId},
        ${attemptId},
        ${attempt.score},
        ${attempt.nickname},
        'open',
        ${expiresAt.toISOString()},
        ${now.toISOString()},
        ${now.toISOString()}
      )
    `;

    const response = CreateChallengeResponseSchema.parse({
      challenge: {
        token,
        status: "open",
        quizDate: attempt.quiz_date,
        expiresAt: expiresAt.toISOString(),
        creatorScore: attempt.score,
      },
    });

    // Persist everything except the raw token.
    const { token: _omitted, ...storedChallenge } = response.challenge;
    await transaction`
      UPDATE idempotency_records
      SET
        status = 'completed',
        response_status = 200,
        response_body = ${JSON.stringify({ challenge: storedChallenge })}::jsonb,
        resource_id = ${challengeId}
      WHERE user_id = ${userId}
        AND operation = ${operation}
        AND key_hash = ${keyHash}
    `;

    return { response };
  });

  return result.response;
}

// ---------------------------------------------------------------------------
// GET /v1/challenges/{token}
// ---------------------------------------------------------------------------

export async function getChallengeLanding(
  database: Database,
  tokens: ChallengeTokenService,
  userId: string,
  token: string,
  now = new Date(),
): Promise<ChallengeLandingResponse> {
  const tokenHash = tokens.hash(token);

  return database.client.begin(async (transaction) => {
    const locked = await lockChallengeByHash(transaction, tokenHash);
    if (locked === undefined) {
      throw notFound();
    }
    const row = await reconcileExpiry(transaction, locked, now);

    const viewerRole =
      row.creator_user_id === userId
        ? "creator"
        : row.claimed_by_user_id === userId
          ? "opponent"
          : "none";

    // Non-participants must not learn about expired/redacted links.
    if (
      viewerRole === "none" &&
      (row.status === "expired" ||
        row.result_redacted_at !== null ||
        row.creator_nickname_snapshot === null)
    ) {
      throw notFound();
    }

    if (row.status !== "expired") {
      const dailySetVoid = await loadDailySetVoid(
        transaction,
        row.daily_set_id,
      );
      if (dailySetVoid !== undefined) {
        return ChallengeLandingResponseSchema.parse({
          status: "voided",
          quizDate: row.quiz_date,
          voidedAt: toIso(dailySetVoid.voided_at),
          viewerRole,
        });
      }
    }

    return ChallengeLandingResponseSchema.parse({
      status: row.status,
      quizDate: row.quiz_date,
      expiresAt: toIso(row.expires_at),
      creatorNickname: row.creator_nickname_snapshot ?? "탈퇴한 사용자",
      viewerRole,
    });
  });
}

// ---------------------------------------------------------------------------
// POST /v1/challenges/{token}/claim
// ---------------------------------------------------------------------------

export async function claimChallenge(
  database: Database,
  tokens: ChallengeTokenService,
  userId: string,
  token: string,
  now = new Date(),
  notificationDeliveryEnabled = true,
): Promise<ClaimChallengeResponse> {
  const tokenHash = tokens.hash(token);

  return database.client.begin(async (transaction) => {
    const user = await loadUser(transaction, userId);

    // 1. Conditional claim. The row lock in lockChallengeByHash serializes
    //    competing claimers; only the first sees status='open'.
    const locked = await lockChallengeByHash(transaction, tokenHash);
    if (locked === undefined) {
      throw notFound();
    }
    const row = await reconcileExpiry(transaction, locked, now);

    if (row.result_redacted_at !== null) {
      throw notFound();
    }
    if (row.creator_user_id === userId) {
      throw new AppError({
        statusCode: 403,
        code: "SELF_CLAIM_FORBIDDEN",
        message: "내가 만든 도전에는 참여할 수 없습니다.",
      });
    }
    if (row.status === "expired") {
      throw notFound();
    }

    const dailySetVoid = await lockDailySetAndLoadVoid(
      transaction,
      row.daily_set_id,
    );
    if (dailySetVoid !== undefined) {
      throw dailySetVoidedError(row.quiz_date, dailySetVoid.voided_at);
    }

    // Replay: same opponent re-posting claim gets the same result.
    if (row.claimed_by_user_id === userId && row.status !== "open") {
      const daily = await startOrResumeAttempt(transaction, {
        userId,
        now,
        setFilter: { dailySetId: row.daily_set_id },
        challengeId: row.id,
      });
      if (daily.status === "voided") {
        throw dailySetVoidedError(row.quiz_date, daily.voidedAt);
      }
      return ClaimChallengeResponseSchema.parse({
        challenge: {
          status: row.status === "completed" ? "completed" : "claimed",
          quizDate: row.quiz_date,
          expiresAt: toIso(row.expires_at),
        },
        daily,
      });
    }

    if (row.status !== "open") {
      throw new AppError({
        statusCode: 409,
        code: "ALREADY_CLAIMED",
        message: "이미 다른 친구가 참여한 도전입니다.",
      });
    }
    if (
      row.creator_user_id === null ||
      row.creator_attempt_id === null ||
      row.creator_score === null
    ) {
      throw notFound();
    }

    // 2. Same (user, daily_set) attempt: reuse or create. Only a newly created
    //    attempt records this challenge as its immutable deadline provenance.
    const daily = await startOrResumeAttempt(transaction, {
      userId,
      now,
      setFilter: { dailySetId: row.daily_set_id },
      challengeId: row.id,
    });
    if (daily.status === "voided") {
      throw dailySetVoidedError(row.quiz_date, daily.voidedAt);
    }

    if (daily.attempt.status === "abandoned") {
      throw new AppError({
        statusCode: 409,
        code: "ATTEMPT_ABANDONED",
        message: "이 날짜의 퀴즈는 더 이상 완료할 수 없습니다.",
      });
    }

    // 3. Link opponent; 4. transition straight to completed if already done.
    const alreadyCompleted =
      daily.attempt.status === "completed" && daily.attempt.score !== null;

    const updated = await transaction<{ id: string }[]>`
      UPDATE challenges
      SET
        status = 'claimed',
        claimed_by_user_id = ${userId},
        opponent_attempt_id = ${daily.attempt.id},
        opponent_nickname_snapshot = ${user.nickname},
        claimed_at = ${now.toISOString()},
        updated_at = ${now.toISOString()}
      WHERE id = ${row.id}
        AND status = 'open'
        AND claimed_by_user_id IS NULL
        AND creator_user_id <> ${userId}
        AND expires_at > ${now.toISOString()}
      RETURNING id
    `;
    if (updated.length === 0) {
      throw new AppError({
        statusCode: 409,
        code: "ALREADY_CLAIMED",
        message: "이미 다른 친구가 참여한 도전입니다.",
      });
    }

    if (alreadyCompleted) {
      const completedChallenges = await transaction<{ id: string }[]>`
        UPDATE challenges
        SET
          status = 'completed',
          opponent_score = ${daily.attempt.score},
          completed_at = ${now.toISOString()},
          updated_at = ${now.toISOString()}
        WHERE id = ${row.id} AND status = 'claimed'
        RETURNING id
      `;
      await enqueueChallengeCompletionNotifications(
        transaction,
        completedChallenges.map((challenge) => challenge.id),
        notificationDeliveryEnabled,
      );
    }

    return ClaimChallengeResponseSchema.parse({
      challenge: {
        status: alreadyCompleted ? "completed" : "claimed",
        quizDate: row.quiz_date,
        expiresAt: toIso(row.expires_at),
      },
      daily,
    });
  });
}

// ---------------------------------------------------------------------------
// GET /v1/challenges/{token}/result
// ---------------------------------------------------------------------------

function outcomeFor(mine: number, theirs: number): "win" | "loss" | "draw" {
  if (mine > theirs) return "win";
  if (mine < theirs) return "loss";
  return "draw";
}

export async function getChallengeResult(
  database: Database,
  tokens: ChallengeTokenService,
  userId: string,
  token: string,
  now = new Date(),
): Promise<ChallengeResultResponse> {
  const tokenHash = tokens.hash(token);

  return database.client.begin(async (transaction) => {
    const locked = await lockChallengeByHash(transaction, tokenHash);
    if (locked === undefined) {
      throw notFound();
    }
    const row = await reconcileExpiry(transaction, locked, now);

    if (row.status === "expired") {
      throw notFound();
    }

    const viewerRole =
      row.creator_user_id === userId
        ? "creator"
        : row.claimed_by_user_id === userId
          ? "opponent"
          : null;
    if (viewerRole === null) {
      throw notFound();
    }

    const dailySetVoid = await loadDailySetVoid(transaction, row.daily_set_id);
    if (dailySetVoid !== undefined) {
      return ChallengeResultResponseSchema.parse({
        status: "voided",
        quizDate: row.quiz_date,
        voidedAt: toIso(dailySetVoid.voided_at),
        viewerRole,
      });
    }

    const meNickname =
      viewerRole === "creator"
        ? row.creator_nickname_snapshot
        : row.opponent_nickname_snapshot;
    const meScore =
      viewerRole === "creator" ? row.creator_score : row.opponent_score;
    const theirNickname =
      viewerRole === "creator"
        ? row.opponent_nickname_snapshot
        : row.creator_nickname_snapshot;
    const theirScore =
      viewerRole === "creator" ? row.opponent_score : row.creator_score;

    if (row.result_redacted_at !== null) {
      return ChallengeResultResponseSchema.parse({
        status: "redacted",
        quizDate: row.quiz_date,
        viewerRole,
        me: { nickname: meNickname ?? "탈퇴한 사용자", score: meScore },
      });
    }

    if (
      row.status === "completed" &&
      meScore !== null &&
      theirScore !== null &&
      meNickname !== null &&
      theirNickname !== null &&
      row.completed_at !== null
    ) {
      return ChallengeResultResponseSchema.parse({
        status: "completed",
        quizDate: row.quiz_date,
        completedAt: toIso(row.completed_at),
        viewerRole,
        outcome: outcomeFor(meScore, theirScore),
        me: { nickname: meNickname, score: meScore },
        opponent: { nickname: theirNickname, score: theirScore },
      });
    }

    // Open / claimed: never reveal the other side's score.
    // An opponent viewing a still-"claimed" challenge sees their own score
    // only once their attempt is completed (opponent_score is set on
    // completion), so `meScore` is null until then.
    return ChallengeResultResponseSchema.parse({
      status: row.status,
      quizDate: row.quiz_date,
      expiresAt: toIso(row.expires_at),
      viewerRole,
      me: { nickname: meNickname ?? "익명 도전자", score: meScore },
      opponent: { nickname: theirNickname, completed: false },
    });
  });
}
