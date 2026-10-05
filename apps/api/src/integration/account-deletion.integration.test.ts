import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  ChallengeResultResponseSchema,
  ClaimChallengeResponseSchema,
  CompleteAttemptResponseSchema,
  CreateChallengeResponseSchema,
  DailyStartResponseSchema,
  DeleteAccountResponseSchema,
  type CreateChallengeResponse,
  type DailyStartResponse,
} from "@daily-quiz-battle/contracts";
import { decodeJwt } from "jose";
import { fingerprintAnonymousKey } from "../shared/hash.js";
import {
  createIntegrationHarness,
  PRIMARY_DAY_NOON,
  type IntegrationHarness,
} from "./test-harness.js";

interface JsonResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

interface TestUser {
  anonymousKey: string;
  token: string;
  userId: string;
}

type AvailableDailyStart = Extract<DailyStartResponse, { status: "available" }>;

interface UserLifecycleRow {
  anon_key_fingerprint: string;
  identity_status: "active" | "deleted" | "blocked";
  identity_verified_at: Date | string | null;
  deleted_at: Date | string | null;
  nickname: string;
  token_version: number;
  streak_days: number;
  last_daily_date: string | null;
  updated_at: Date | string;
}

interface ChallengeDeletionRow {
  creator_user_id: string | null;
  creator_attempt_id: string | null;
  creator_score: number | null;
  creator_nickname_snapshot: string | null;
  claimed_by_user_id: string | null;
  opponent_attempt_id: string | null;
  opponent_score: number | null;
  opponent_nickname_snapshot: string | null;
  status: "open" | "claimed" | "completed" | "expired";
  result_redacted_at: Date | string | null;
}

interface LockBarrier {
  release(): void;
  completion: Promise<void>;
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

function getTokenUserId(token: string): string {
  const userId = decodeJwt(token).sub;
  assert.ok(userId, "issued access token must contain a subject");
  return userId;
}

async function bootstrapUser(identity: string): Promise<TestUser> {
  const anonymousKey = `dev-account-deletion-it-${identity}`;
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(response.statusCode, 200, response.body);
  const token = BootstrapResponseSchema.parse(response.json()).accessToken;
  return { anonymousKey, token, userId: getTokenUserId(token) };
}

async function rebootstrapUser(anonymousKey: string): Promise<TestUser> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(response.statusCode, 200, response.body);
  const token = BootstrapResponseSchema.parse(response.json()).accessToken;
  return { anonymousKey, token, userId: getTokenUserId(token) };
}

async function requestRefresh(user: TestUser): Promise<JsonResponse> {
  return harness.app.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    payload: {
      anonymousKey: user.anonymousKey,
      expectedUserId: user.userId,
    },
  });
}

async function countUsers(): Promise<number> {
  const rows = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM users
  `;
  return rows[0]!.count;
}

async function setNickname(userId: string, nickname: string): Promise<void> {
  await harness.database.client`
    UPDATE users
    SET nickname = ${nickname}
    WHERE id = ${userId}
  `;
}

async function startQuiz(token: string): Promise<AvailableDailyStart> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(token),
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  const start = DailyStartResponseSchema.parse(response.json());
  assert.equal(start.status, "available");
  return start as AvailableDailyStart;
}

function completionPayload(start: AvailableDailyStart, expectedScore: number) {
  const answers = start.questions.map((question, index) => {
    const correctIndex = correctSelections[index]!;
    const selectedIndex =
      index < expectedScore ? correctIndex : (correctIndex + 1) % 4;
    return {
      sequence: question.sequence,
      questionRevisionId: question.revisionId,
      selectedIndex,
    };
  });
  return { answers };
}

async function requestCompletion(
  user: TestUser,
  start: AvailableDailyStart,
  idempotencyKey: string,
  expectedScore: number,
): Promise<JsonResponse> {
  return harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${start.attempt.id}/complete`,
    headers: idempotentHeaders(user.token, idempotencyKey),
    payload: completionPayload(start, expectedScore),
  });
}

async function finishQuiz(
  user: TestUser,
  keyPrefix: string,
  expectedScore: number,
  existingStart?: AvailableDailyStart,
): Promise<AvailableDailyStart> {
  const start = existingStart ?? (await startQuiz(user.token));
  const completion = await requestCompletion(
    user,
    start,
    `${keyPrefix}-complete`,
    expectedScore,
  );
  assert.equal(completion.statusCode, 200, completion.body);
  const completed = CompleteAttemptResponseSchema.parse(completion.json());
  assert.equal(completed.status, "completed");
  if (completed.status !== "completed") {
    assert.fail("expected a completed daily result");
  }
  assert.equal(completed.score, expectedScore);
  return {
    ...start,
    attempt: {
      ...start.attempt,
      status: "completed",
      answeredCount: 5,
      score: completed.score,
    },
  };
}

async function createChallenge(
  user: TestUser,
  attemptId: string,
  idempotencyKey: string,
): Promise<CreateChallengeResponse> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(user.token, idempotencyKey),
    payload: { attemptId },
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateChallengeResponseSchema.parse(response.json());
}

async function claimChallenge(
  user: TestUser,
  challengeToken: string,
  idempotencyKey: string,
): Promise<void> {
  const response = await requestClaimChallenge(
    user,
    challengeToken,
    idempotencyKey,
  );
  assert.equal(response.statusCode, 200, response.body);
  const claimed = ClaimChallengeResponseSchema.parse(response.json());
  assert.equal(claimed.challenge.status, "completed");
}

async function requestClaimChallenge(
  user: TestUser,
  challengeToken: string,
  idempotencyKey: string,
): Promise<JsonResponse> {
  return harness.app.inject({
    method: "POST",
    url: `/v1/challenges/${challengeToken}/claim`,
    headers: idempotentHeaders(user.token, idempotencyKey),
    payload: {},
  });
}

async function createReport(
  user: TestUser,
  questionRevisionId: string,
): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/reports/questions",
    headers: authorizationHeaders(user.token),
    payload: {
      questionRevisionId,
      reasonCode: "incorrect_answer",
      detail: "Account deletion integration fixture",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function deleteUser(user: TestUser): Promise<JsonResponse> {
  return harness.app.inject({
    method: "DELETE",
    url: "/v1/me",
    headers: authorizationHeaders(user.token),
    payload: { confirmation: "DELETE" },
  });
}

async function holdUserLock(userId: string): Promise<LockBarrier> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquiredResolve!: () => void;
  let acquiredReject!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const completion = harness.database.client
    .begin(async (transaction) => {
      await transaction`
        SELECT id
        FROM users
        WHERE id = ${userId}
        FOR UPDATE
      `;
      acquiredResolve();
      await released;
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      acquiredReject(error);
      throw error;
    });
  await acquired;
  return { release, completion };
}

async function holdChallengeLock(challengeId: string): Promise<LockBarrier> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquiredResolve!: () => void;
  let acquiredReject!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const completion = harness.database.client
    .begin(async (transaction) => {
      await transaction`
        SELECT id
        FROM challenges
        WHERE id = ${challengeId}
        FOR UPDATE
      `;
      acquiredResolve();
      await released;
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      acquiredReject(error);
      throw error;
    });
  await acquired;
  return { release, completion };
}

async function waitForBlockedUserLocks(
  minimum: number,
  timeoutMs = 2_000,
  lockMode: "UPDATE" | "SHARE" = "UPDATE",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await harness.database.client<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%FROM users%'
        AND query ILIKE ${`%FOR ${lockMode}%`}
    `;
    if ((rows[0]?.count ?? 0) >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${minimum} blocked user lock(s)`);
}

async function waitForBlockedChallengeLocks(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await harness.database.client<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%challenges%'
    `;
    if ((rows[0]?.count ?? 0) >= 1) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for a blocked challenge lock");
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function getUserLifecycle(userId: string): Promise<UserLifecycleRow> {
  const rows = await harness.database.client<UserLifecycleRow[]>`
    SELECT
      anon_key_fingerprint,
      identity_status::text AS identity_status,
      identity_verified_at,
      deleted_at,
      nickname,
      token_version::int AS token_version,
      streak_days::int AS streak_days,
      last_daily_date::text AS last_daily_date,
      updated_at
    FROM users
    WHERE id = ${userId}
  `;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

async function countPrivateRows(userId: string): Promise<{
  attempts: number;
  answers: number;
  reports: number;
  idempotency: number;
}> {
  const rows = await harness.database.client<
    {
      attempts: number;
      answers: number;
      reports: number;
      idempotency: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM attempts WHERE user_id = ${userId}) AS attempts,
      (
        SELECT count(*)::int
        FROM attempt_answers aa
        JOIN attempts a ON a.id = aa.attempt_id
        WHERE a.user_id = ${userId}
      ) AS answers,
      (SELECT count(*)::int FROM reports WHERE reporter_user_id = ${userId}) AS reports,
      (SELECT count(*)::int FROM idempotency_records WHERE user_id = ${userId}) AS idempotency
  `;
  return rows[0]!;
}

async function countAttemptAnswers(attemptId: string): Promise<number> {
  const rows = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM attempt_answers
    WHERE attempt_id = ${attemptId}
  `;
  return rows[0]!.count;
}

async function assertOldTokenRejected(token: string): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(token),
    payload: {},
  });
  expectApiError(response, 401, "UNAUTHORIZED");
}

test("refresh keeps the verified identity and issues its current token version without mutations", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const user = await bootstrapUser("refresh-active");
  // A stored verified key need not pass the current mock verifier's dev- prefix rule.
  user.anonymousKey = "previously-verified-account-refresh-identity";
  await harness.database.client`
    UPDATE users
    SET anon_key_fingerprint = ${fingerprintAnonymousKey(user.anonymousKey, harness.config.anonymousKeyPepper)}
    WHERE id = ${user.userId}
  `;
  const before = await getUserLifecycle(user.userId);
  assert.ok(before.identity_verified_at);
  const totalUsers = await countUsers();

  const response = await requestRefresh(user);
  assert.equal(response.statusCode, 200, response.body);
  const refreshed = BootstrapResponseSchema.parse(response.json());
  assert.deepEqual(refreshed.user, {
    id: user.userId,
    nickname: before.nickname,
  });
  assert.equal(
    refreshed.expiresInSeconds,
    harness.config.accessTokenTtlSeconds,
  );
  assert.equal(getTokenUserId(refreshed.accessToken), user.userId);
  assert.equal(
    decodeJwt(refreshed.accessToken).tokenVersion,
    before.token_version,
  );
  assert.equal(await countUsers(), totalUsers);
  assert.deepEqual(await getUserLifecycle(user.userId), before);
  await startQuiz(refreshed.accessToken);

  await harness.database.client`
    UPDATE users
    SET token_version = token_version + 1
    WHERE id = ${user.userId}
  `;
  const afterIncrement = await getUserLifecycle(user.userId);
  assert.equal(afterIncrement.token_version, before.token_version + 1);
  await assertOldTokenRejected(user.token);
  await assertOldTokenRejected(refreshed.accessToken);

  const renewedResponse = await requestRefresh(user);
  assert.equal(renewedResponse.statusCode, 200, renewedResponse.body);
  const renewed = BootstrapResponseSchema.parse(renewedResponse.json());
  assert.deepEqual(renewed.user, refreshed.user);
  assert.equal(getTokenUserId(renewed.accessToken), user.userId);
  assert.equal(
    decodeJwt(renewed.accessToken).tokenVersion,
    afterIncrement.token_version,
  );
  assert.equal(await countUsers(), totalUsers);
  assert.deepEqual(await getUserLifecycle(user.userId), afterIncrement);
  await startQuiz(renewed.accessToken);
});

test("refresh rejects mismatched or missing identities and malformed bodies without creating users", async () => {
  const user = await bootstrapUser("refresh-mismatch");
  const other = await bootstrapUser("refresh-mismatch-other");
  const before = await getUserLifecycle(user.userId);
  const otherBefore = await getUserLifecycle(other.userId);
  const totalUsers = await countUsers();
  for (const payload of [
    { anonymousKey: user.anonymousKey, expectedUserId: other.userId },
    { anonymousKey: other.anonymousKey, expectedUserId: user.userId },
    {
      anonymousKey: "dev-account-deletion-it-refresh-unknown",
      expectedUserId: user.userId,
    },
    {
      anonymousKey: user.anonymousKey,
      expectedUserId: "00000000-0000-4000-8000-000000000000",
    },
  ]) {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload,
    });
    expectApiError(response, 401, "UNAUTHORIZED");
    assert.equal(await countUsers(), totalUsers);
  }
  for (const payload of [
    { expectedUserId: user.userId },
    { anonymousKey: user.anonymousKey },
    { anonymousKey: user.anonymousKey, expectedUserId: "not-a-uuid" },
    {
      anonymousKey: user.anonymousKey,
      expectedUserId: user.userId,
      extra: true,
    },
  ]) {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload,
    });
    expectApiError(response, 400, "INVALID_REQUEST");
    assert.equal(await countUsers(), totalUsers);
  }
  assert.deepEqual(await getUserLifecycle(user.userId), before);
  assert.deepEqual(await getUserLifecycle(other.userId), otherBefore);
});

test("refresh cannot recreate a deleted identity or switch to a replacement account", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const user = await bootstrapUser("refresh-deleted");
  const before = await getUserLifecycle(user.userId);
  const deletion = await deleteUser(user);
  assert.equal(deletion.statusCode, 200, deletion.body);
  DeleteAccountResponseSchema.parse(deletion.json());
  const tombstone = await getUserLifecycle(user.userId);
  assert.equal(tombstone.identity_status, "deleted");
  assert.notEqual(tombstone.anon_key_fingerprint, before.anon_key_fingerprint);
  const totalUsers = await countUsers();

  expectApiError(await requestRefresh(user), 401, "UNAUTHORIZED");
  assert.equal(await countUsers(), totalUsers);
  assert.deepEqual(await getUserLifecycle(user.userId), tombstone);

  const replacement = await rebootstrapUser(user.anonymousKey);
  assert.notEqual(replacement.userId, user.userId);
  assert.equal(await countUsers(), totalUsers + 1);
  const replacementBefore = await getUserLifecycle(replacement.userId);
  expectApiError(await requestRefresh(user), 401, "UNAUTHORIZED");
  assert.equal(await countUsers(), totalUsers + 1);
  assert.deepEqual(await getUserLifecycle(user.userId), tombstone);
  assert.deepEqual(
    await getUserLifecycle(replacement.userId),
    replacementBefore,
  );
});

test("refresh rejects a blocked identity without altering it", async () => {
  const user = await bootstrapUser("refresh-blocked");
  await harness.database.client`
    UPDATE users
    SET identity_status = 'blocked'
    WHERE id = ${user.userId}
  `;
  const before = await getUserLifecycle(user.userId);
  const totalUsers = await countUsers();

  expectApiError(await requestRefresh(user), 401, "UNAUTHORIZED");
  assert.equal(await countUsers(), totalUsers);
  assert.deepEqual(await getUserLifecycle(user.userId), before);
});

test(
  "refresh waits for a deletion-held user lock and rejects the committed tombstone",
  { timeout: 8_000 },
  async () => {
    harness.setNow(PRIMARY_DAY_NOON);
    const user = await bootstrapUser("refresh-deletion-lock");
    const attempt = await finishQuiz(user, "refresh-deletion-lock", 2);
    await createChallenge(
      user,
      attempt.attempt.id,
      "refresh-deletion-lock-challenge",
    );
    const challenges = await harness.database.client<{ id: string }[]>`
      SELECT id
      FROM challenges
      WHERE creator_user_id = ${user.userId}
        AND creator_attempt_id = ${attempt.attempt.id}
    `;
    assert.equal(challenges.length, 1);
    const totalUsers = await countUsers();
    const barrier = await holdChallengeLock(challenges[0]!.id);
    const deletionPromise = deleteUser(user);
    try {
      await waitForBlockedChallengeLocks();
      const refreshPromise = requestRefresh(user);
      try {
        await waitForBlockedUserLocks(1, 2_000, "SHARE");
      } finally {
        barrier.release();
      }
      const [, deletionResponse, refreshResponse] = await withTimeout(
        Promise.all([barrier.completion, deletionPromise, refreshPromise]),
        "refresh and deletion",
      );
      assert.equal(deletionResponse.statusCode, 200, deletionResponse.body);
      DeleteAccountResponseSchema.parse(deletionResponse.json());
      expectApiError(refreshResponse, 401, "UNAUTHORIZED");
      const tombstone = await getUserLifecycle(user.userId);
      assert.equal(tombstone.identity_status, "deleted");
      assert.equal(await countUsers(), totalUsers);
      expectApiError(await requestRefresh(user), 401, "UNAUTHORIZED");
      assert.deepEqual(await getUserLifecycle(user.userId), tombstone);
    } finally {
      barrier.release();
      await withTimeout(barrier.completion, "refresh deletion lock release");
    }
  },
);

test("account deletion requires the exact confirmation", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const user = await bootstrapUser("confirmation-user");
  const before = await getUserLifecycle(user.userId);

  const response = await harness.app.inject({
    method: "DELETE",
    url: "/v1/me",
    headers: authorizationHeaders(user.token),
    payload: { confirmation: "delete" },
  });
  expectApiError(response, 400, "INVALID_REQUEST");

  const afterInvalidRequest = await getUserLifecycle(user.userId);
  assert.ok(
    afterInvalidRequest.anon_key_fingerprint === before.anon_key_fingerprint,
    "invalid confirmation must not replace the anonymous-key fingerprint",
  );
  assert.deepEqual(
    {
      ...afterInvalidRequest,
      anon_key_fingerprint: undefined,
    },
    {
      ...before,
      anon_key_fingerprint: undefined,
    },
  );
});

for (const scenario of [
  {
    label: "creator-side",
    deletedRole: "creator",
    creatorNickname: "삭제창작자",
    opponentNickname: "잔존상대",
    creatorScore: 4,
    opponentScore: 2,
  },
  {
    label: "opponent-side",
    deletedRole: "opponent",
    creatorNickname: "잔존창작자",
    opponentNickname: "삭제상대",
    creatorScore: 1,
    opponentScore: 5,
  },
] as const) {
  test(`completed challenge redacts ${scenario.deletedRole} deletion and erases private rows`, async () => {
    harness.setNow(PRIMARY_DAY_NOON);
    const creator = await bootstrapUser(`${scenario.label}-creator`);
    const opponent = await bootstrapUser(`${scenario.label}-opponent`);
    await setNickname(creator.userId, scenario.creatorNickname);
    await setNickname(opponent.userId, scenario.opponentNickname);

    const creatorAttempt = await finishQuiz(
      creator,
      `${scenario.label}-creator`,
      scenario.creatorScore,
    );
    const opponentAttempt = await finishQuiz(
      opponent,
      `${scenario.label}-opponent`,
      scenario.opponentScore,
    );
    const created = await createChallenge(
      creator,
      creatorAttempt.attempt.id,
      `${scenario.label}-challenge-create`,
    );
    await claimChallenge(
      opponent,
      created.challenge.token,
      `${scenario.label}-challenge-claim`,
    );

    const deleted = scenario.deletedRole === "creator" ? creator : opponent;
    const survivor = scenario.deletedRole === "creator" ? opponent : creator;
    const deletedAttempt =
      scenario.deletedRole === "creator" ? creatorAttempt : opponentAttempt;
    const survivorScore =
      scenario.deletedRole === "creator"
        ? scenario.opponentScore
        : scenario.creatorScore;
    const survivorNickname =
      scenario.deletedRole === "creator"
        ? scenario.opponentNickname
        : scenario.creatorNickname;
    const deletedNickname =
      scenario.deletedRole === "creator"
        ? scenario.creatorNickname
        : scenario.opponentNickname;

    await createReport(deleted, deletedAttempt.questions[0]!.revisionId);
    await harness.database.client`
      UPDATE users
      SET streak_days = 9,
          last_daily_date = '2026-08-29'
      WHERE id = ${deleted.userId}
    `;

    const lifecycleBefore = await getUserLifecycle(deleted.userId);
    const privateRowsBefore = await countPrivateRows(deleted.userId);
    assert.equal(privateRowsBefore.attempts, 1);
    assert.equal(privateRowsBefore.answers, 5);
    assert.equal(privateRowsBefore.reports, 1);
    assert.ok(privateRowsBefore.idempotency > 0);

    const deletionResponse = await deleteUser(deleted);
    assert.equal(deletionResponse.statusCode, 200, deletionResponse.body);
    const deletion = DeleteAccountResponseSchema.parse(deletionResponse.json());
    assert.equal(deletion.status, "deleted");
    assert.equal(deletion.deletedAt, PRIMARY_DAY_NOON.toISOString());

    const lifecycleAfter = await getUserLifecycle(deleted.userId);
    assert.equal(lifecycleAfter.identity_status, "deleted");
    assert.equal(lifecycleAfter.nickname, "탈퇴한 사용자");
    assert.equal(
      lifecycleAfter.token_version,
      lifecycleBefore.token_version + 1,
    );
    assert.equal(lifecycleAfter.streak_days, 0);
    assert.equal(lifecycleAfter.last_daily_date, null);
    assert.equal(
      new Date(lifecycleAfter.deleted_at!).toISOString(),
      PRIMARY_DAY_NOON.toISOString(),
    );
    assert.ok(
      lifecycleAfter.anon_key_fingerprint !==
        lifecycleBefore.anon_key_fingerprint,
      "deletion must replace the anonymous-key fingerprint",
    );
    assert.ok(
      /^[0-9a-f]{64}$/.test(lifecycleAfter.anon_key_fingerprint),
      "replacement fingerprint must retain the storage format",
    );

    assert.deepEqual(await countPrivateRows(deleted.userId), {
      attempts: 0,
      answers: 0,
      reports: 0,
      idempotency: 0,
    });
    assert.equal(await countAttemptAnswers(deletedAttempt.attempt.id), 0);

    const challengeByParticipants = await harness.database.client<
      ChallengeDeletionRow[]
    >`
      SELECT
        creator_user_id,
        creator_attempt_id,
        creator_score::int AS creator_score,
        creator_nickname_snapshot,
        claimed_by_user_id,
        opponent_attempt_id,
        opponent_score::int AS opponent_score,
        opponent_nickname_snapshot,
        status::text AS status,
        result_redacted_at
      FROM challenges
      WHERE creator_user_id = ${creator.userId}
        AND claimed_by_user_id = ${opponent.userId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    assert.equal(challengeByParticipants.length, 1);
    const challenge = challengeByParticipants[0]!;
    assert.equal(challenge.status, "completed");
    assert.ok(challenge.result_redacted_at);
    if (scenario.deletedRole === "creator") {
      assert.equal(challenge.creator_attempt_id, null);
      assert.equal(challenge.creator_score, null);
      assert.equal(challenge.creator_nickname_snapshot, null);
      assert.equal(challenge.opponent_attempt_id, opponentAttempt.attempt.id);
      assert.equal(challenge.opponent_score, scenario.opponentScore);
      assert.equal(challenge.opponent_nickname_snapshot, survivorNickname);
    } else {
      assert.equal(challenge.creator_attempt_id, creatorAttempt.attempt.id);
      assert.equal(challenge.creator_score, scenario.creatorScore);
      assert.equal(challenge.creator_nickname_snapshot, survivorNickname);
      assert.equal(challenge.opponent_attempt_id, null);
      assert.equal(challenge.opponent_score, null);
      assert.equal(challenge.opponent_nickname_snapshot, null);
    }

    const resultResponse = await harness.app.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}/result`,
      headers: authorizationHeaders(survivor.token),
    });
    assert.equal(resultResponse.statusCode, 200, resultResponse.body);
    const result = ChallengeResultResponseSchema.parse(resultResponse.json());
    assert.equal(result.status, "redacted");
    if (result.status !== "redacted") {
      assert.fail("deleted-account challenge result must be redacted");
    }
    assert.equal(
      result.viewerRole,
      scenario.deletedRole === "creator" ? "opponent" : "creator",
    );
    assert.deepEqual(result.me, {
      nickname: survivorNickname,
      score: survivorScore,
    });
    assert.equal("opponent" in result, false);
    assert.equal(resultResponse.body.includes(deletedNickname), false);

    await assertOldTokenRejected(deleted.token);
    const replacement = await rebootstrapUser(deleted.anonymousKey);
    assert.notEqual(replacement.userId, deleted.userId);
    const replacementStart = await startQuiz(replacement.token);
    assert.equal(replacementStart.attempt.status, "started");
  });
}

test("deleting an open challenge creator expires and redacts the challenge", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("open-creator");
  await setNickname(creator.userId, "공개삭제자");
  const attempt = await finishQuiz(creator, "open-creator", 3);
  const created = await createChallenge(
    creator,
    attempt.attempt.id,
    "open-creator-challenge",
  );

  const deletionResponse = await deleteUser(creator);
  assert.equal(deletionResponse.statusCode, 200, deletionResponse.body);

  const rows = await harness.database.client<ChallengeDeletionRow[]>`
    SELECT
      creator_user_id,
      creator_attempt_id,
      creator_score::int AS creator_score,
      creator_nickname_snapshot,
      claimed_by_user_id,
      opponent_attempt_id,
      opponent_score::int AS opponent_score,
      opponent_nickname_snapshot,
      status::text AS status,
      result_redacted_at
    FROM challenges
    WHERE creator_user_id = ${creator.userId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  assert.equal(rows.length, 1);
  const challenge = rows[0]!;
  assert.equal(challenge.status, "expired");
  assert.ok(challenge.result_redacted_at);
  assert.equal(challenge.creator_attempt_id, null);
  assert.equal(challenge.creator_score, null);
  assert.equal(challenge.creator_nickname_snapshot, null);
  assert.equal(challenge.claimed_by_user_id, null);
  assert.equal(challenge.opponent_attempt_id, null);
  assert.equal(challenge.opponent_score, null);
  assert.equal(challenge.opponent_nickname_snapshot, null);

  await assertOldTokenRejected(creator.token);
  const replacement = await rebootstrapUser(creator.anonymousKey);
  const landing = await harness.app.inject({
    method: "GET",
    url: `/v1/challenges/${created.challenge.token}`,
    headers: authorizationHeaders(replacement.token),
  });
  expectApiError(landing, 404, "CHALLENGE_NOT_FOUND");
});

test("two concurrent deletion requests commit exactly one lifecycle transition", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const user = await bootstrapUser("concurrent-user");
  const attempt = await finishQuiz(user, "concurrent-user", 2);
  await createReport(user, attempt.questions[0]!.revisionId);
  await createChallenge(
    user,
    attempt.attempt.id,
    "concurrent-user-open-challenge",
  );
  const lifecycleBefore = await getUserLifecycle(user.userId);

  const responses = await Promise.all([deleteUser(user), deleteUser(user)]);
  const successes = responses.filter((response) => response.statusCode === 200);
  const rejected = responses.filter((response) => response.statusCode !== 200);
  assert.equal(successes.length, 1);
  assert.equal(rejected.length, 1);
  DeleteAccountResponseSchema.parse(successes[0]!.json());
  expectApiError(rejected[0]!, 401, "UNAUTHORIZED");

  const lifecycleAfter = await getUserLifecycle(user.userId);
  assert.equal(lifecycleAfter.identity_status, "deleted");
  assert.equal(lifecycleAfter.token_version, lifecycleBefore.token_version + 1);
  assert.equal(lifecycleAfter.streak_days, 0);
  assert.equal(lifecycleAfter.last_daily_date, null);
  assert.ok(lifecycleAfter.deleted_at);
  assert.ok(
    lifecycleAfter.anon_key_fingerprint !==
      lifecycleBefore.anon_key_fingerprint,
    "concurrent deletion must replace the fingerprint exactly once",
  );
  assert.deepEqual(await countPrivateRows(user.userId), {
    attempts: 0,
    answers: 0,
    reports: 0,
    idempotency: 0,
  });
  assert.equal(await countAttemptAnswers(attempt.attempt.id), 0);

  const rows = await harness.database.client<
    { count: number; redacted_count: number; expired_count: number }[]
  >`
    SELECT
      count(*)::int AS count,
      count(*) FILTER (WHERE result_redacted_at IS NOT NULL)::int AS redacted_count,
      count(*) FILTER (WHERE status = 'expired')::int AS expired_count
    FROM challenges
    WHERE creator_user_id = ${user.userId}
  `;
  assert.deepEqual(rows[0], {
    count: 1,
    redacted_count: 1,
    expired_count: 1,
  });
  await assertOldTokenRejected(user.token);
});

test(
  "deletion fences a stale claim before it can restore attempt or nickname snapshots",
  { timeout: 8_000 },
  async () => {
    harness.setNow(PRIMARY_DAY_NOON);
    const creator = await bootstrapUser("stale-claim-creator");
    const claimant = await bootstrapUser("stale-claim-claimant");
    await setNickname(claimant.userId, "삭제대기참가자");
    const creatorAttempt = await finishQuiz(creator, "stale-claim-creator", 4);
    await finishQuiz(claimant, "stale-claim-claimant", 3);
    const created = await createChallenge(
      creator,
      creatorAttempt.attempt.id,
      "stale-claim-create",
    );

    const barrier = await holdUserLock(claimant.userId);
    const deletionPromise = deleteUser(claimant);
    await waitForBlockedUserLocks(1);
    const claimPromise = requestClaimChallenge(
      claimant,
      created.challenge.token,
      "stale-claim-after-delete",
    );
    await waitForBlockedUserLocks(2);
    barrier.release();

    const [, deletionResponse, claimResponse] = await withTimeout(
      Promise.all([barrier.completion, deletionPromise, claimPromise]),
      "stale claim and deletion",
    );
    assert.equal(deletionResponse.statusCode, 200, deletionResponse.body);
    DeleteAccountResponseSchema.parse(deletionResponse.json());
    expectApiError(claimResponse, 403, "FORBIDDEN");
    assert.deepEqual(await countPrivateRows(claimant.userId), {
      attempts: 0,
      answers: 0,
      reports: 0,
      idempotency: 0,
    });

    const challenges = await harness.database.client<ChallengeDeletionRow[]>`
      SELECT
        creator_user_id,
        creator_attempt_id,
        creator_score::int AS creator_score,
        creator_nickname_snapshot,
        claimed_by_user_id,
        opponent_attempt_id,
        opponent_score::int AS opponent_score,
        opponent_nickname_snapshot,
        status::text AS status,
        result_redacted_at
      FROM challenges
      WHERE creator_user_id = ${creator.userId}
        AND creator_attempt_id = ${creatorAttempt.attempt.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    assert.equal(challenges.length, 1);
    assert.equal(challenges[0]!.status, "open");
    assert.equal(challenges[0]!.claimed_by_user_id, null);
    assert.equal(challenges[0]!.opponent_attempt_id, null);
    assert.equal(challenges[0]!.opponent_score, null);
    assert.equal(challenges[0]!.opponent_nickname_snapshot, null);
  },
);

test(
  "complete and deletion follow user then challenge lock order without deadlock",
  { timeout: 8_000 },
  async () => {
    harness.setNow(PRIMARY_DAY_NOON);
    const creator = await bootstrapUser("complete-delete-creator");
    const opponent = await bootstrapUser("complete-delete-opponent");
    await setNickname(opponent.userId, "완료삭제참가자");
    const creatorAttempt = await finishQuiz(
      creator,
      "complete-delete-creator",
      2,
    );
    const created = await createChallenge(
      creator,
      creatorAttempt.attempt.id,
      "complete-delete-create",
    );
    const opponentAttempt = await startQuiz(opponent.token);
    const claimResponse = await requestClaimChallenge(
      opponent,
      created.challenge.token,
      "complete-delete-claim",
    );
    assert.equal(claimResponse.statusCode, 200, claimResponse.body);
    const claimed = ClaimChallengeResponseSchema.parse(claimResponse.json());
    assert.equal(claimed.challenge.status, "claimed");

    const challengeIds = await harness.database.client<{ id: string }[]>`
      SELECT id
      FROM challenges
      WHERE creator_user_id = ${creator.userId}
        AND claimed_by_user_id = ${opponent.userId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    assert.equal(challengeIds.length, 1);
    const barrier = await holdChallengeLock(challengeIds[0]!.id);
    const completionPromise = requestCompletion(
      opponent,
      opponentAttempt,
      "complete-delete-complete",
      5,
    );
    await waitForBlockedChallengeLocks();
    const deletionPromise = deleteUser(opponent);
    await waitForBlockedUserLocks(1);
    barrier.release();

    const [, completionResponse, deletionResponse] = await withTimeout(
      Promise.all([barrier.completion, completionPromise, deletionPromise]),
      "complete and deletion",
    );
    assert.equal(completionResponse.statusCode, 200, completionResponse.body);
    CompleteAttemptResponseSchema.parse(completionResponse.json());
    assert.equal(deletionResponse.statusCode, 200, deletionResponse.body);
    DeleteAccountResponseSchema.parse(deletionResponse.json());
    assert.deepEqual(await countPrivateRows(opponent.userId), {
      attempts: 0,
      answers: 0,
      reports: 0,
      idempotency: 0,
    });

    const challenges = await harness.database.client<ChallengeDeletionRow[]>`
      SELECT
        creator_user_id,
        creator_attempt_id,
        creator_score::int AS creator_score,
        creator_nickname_snapshot,
        claimed_by_user_id,
        opponent_attempt_id,
        opponent_score::int AS opponent_score,
        opponent_nickname_snapshot,
        status::text AS status,
        result_redacted_at
      FROM challenges
      WHERE creator_user_id = ${creator.userId}
        AND claimed_by_user_id = ${opponent.userId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    assert.equal(challenges.length, 1);
    assert.equal(challenges[0]!.status, "completed");
    assert.ok(challenges[0]!.result_redacted_at);
    assert.equal(challenges[0]!.opponent_attempt_id, null);
    assert.equal(challenges[0]!.opponent_score, null);
    assert.equal(challenges[0]!.opponent_nickname_snapshot, null);
  },
);
