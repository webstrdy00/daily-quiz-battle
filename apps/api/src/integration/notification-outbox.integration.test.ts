import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  BootstrapResponseSchema,
  ClaimChallengeResponseSchema,
  CompleteAttemptResponseSchema,
  CreateChallengeResponseSchema,
  DailyStartResponseSchema,
  type CompletedAttemptResponse,
  type DailyAvailableStartResponse,
} from "@daily-quiz-battle/contracts";
import { decodeJwt } from "jose";
import {
  enqueueChallengeCompletionNotifications,
  runNotificationWorker,
  type NotificationWorkerCounts,
} from "../notification/outbox.js";
import type {
  NotificationSender,
  SendNotificationInput,
} from "../notification/sender.js";
import {
  createIntegrationHarness,
  PRIMARY_DAY_NOON,
  type IntegrationHarness,
} from "./test-harness.js";

interface TestUser {
  anonymousKey: string;
  token: string;
  userId: string;
}

interface CompletedChallenge {
  challengeId: string;
  publicToken: string;
  creator: TestUser;
  opponent: TestUser;
}

interface OutboxRow {
  id: string;
  challenge_id: string;
  dedupe_key: string;
  status: "pending" | "published" | "failed";
  available_at: Date | string;
  attempt_count: number;
  last_error: string | null;
  published_at: Date | string | null;
}

const correctSelections = [0, 2, 1, 1, 3] as const;
const WORKER_AT = new Date("2030-01-01T00:00:00.000Z");
const zeroCounts: NotificationWorkerCounts = {
  published: 0,
  retried: 0,
  failed: 0,
  skipped: 0,
};

let harness: IntegrationHarness;

before(async () => {
  harness = await createIntegrationHarness();
  harness.setNow(PRIMARY_DAY_NOON);
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

function getTokenUserId(token: string): string {
  const userId = decodeJwt(token).sub;
  assert.ok(userId, "issued access token must contain a subject");
  return userId;
}

async function bootstrapUser(label: string): Promise<TestUser> {
  const anonymousKey = `dev-notification-outbox-it-${label}`;
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(response.statusCode, 200, response.body);
  const token = BootstrapResponseSchema.parse(response.json()).accessToken;
  return { anonymousKey, token, userId: getTokenUserId(token) };
}

async function enableNotifications(user: TestUser): Promise<void> {
  const response = await harness.app.inject({
    method: "PUT",
    url: "/v1/notifications/result-preference",
    headers: authorizationHeaders(user.token),
    payload: { anonymousKey: user.anonymousKey, enabled: true },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function disableNotifications(user: TestUser): Promise<void> {
  const response = await harness.app.inject({
    method: "PUT",
    url: "/v1/notifications/result-preference",
    headers: authorizationHeaders(user.token),
    payload: { anonymousKey: user.anonymousKey, enabled: false },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function startQuiz(user: TestUser): Promise<DailyAvailableStartResponse> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(user.token),
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  const start = DailyStartResponseSchema.parse(response.json());
  if (start.status !== "available") {
    assert.fail("daily set must be available in this fixture");
  }
  return start;
}

function parseCompletedAttempt(value: unknown): CompletedAttemptResponse {
  const result = CompleteAttemptResponseSchema.parse(value);
  if (result.status !== "completed") {
    assert.fail("attempt must be completed in this fixture");
  }
  return result;
}

async function finishQuiz(
  user: TestUser,
  label: string,
  score: number,
  existingStart?: DailyAvailableStartResponse,
): Promise<DailyAvailableStartResponse> {
  const start = existingStart ?? (await startQuiz(user));
  for (const [index, question] of start.questions.entries()) {
    const correctIndex = correctSelections[index]!;
    const selectedIndex = index < score ? correctIndex : (correctIndex + 1) % 4;
    const answer = await harness.app.inject({
      method: "POST",
      url: `/v1/attempts/${start.attempt.id}/answers`,
      headers: idempotentHeaders(user.token, `${label}-answer-${index + 1}`),
      payload: {
        sequence: question.sequence,
        questionRevisionId: question.revisionId,
        selectedIndex,
      },
    });
    assert.equal(answer.statusCode, 200, answer.body);
  }

  const completion = await harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${start.attempt.id}/complete`,
    headers: idempotentHeaders(user.token, `${label}-complete`),
    payload: {},
  });
  assert.equal(completion.statusCode, 200, completion.body);
  const completed = parseCompletedAttempt(completion.json());
  assert.equal(completed.score, score);
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

async function createCompletedChallenge(
  label: string,
  options: {
    notificationsEnabled?: boolean;
    immediate?: boolean;
    replayCompletion?: boolean;
    creatorNickname?: string;
  } = {},
): Promise<CompletedChallenge> {
  const creator = await bootstrapUser(`${label}-creator`);
  const opponent = await bootstrapUser(`${label}-opponent`);
  if (options.creatorNickname !== undefined) {
    await harness.database.client`
      UPDATE users
      SET nickname = ${options.creatorNickname}
      WHERE id = ${creator.userId}
    `;
  }
  if (options.notificationsEnabled !== false) {
    await enableNotifications(creator);
  }

  const creatorAttempt = await finishQuiz(creator, `${label}-creator`, 4);
  const completedOpponentAttempt = options.immediate
    ? await finishQuiz(opponent, `${label}-opponent`, 2)
    : undefined;
  const createResponse = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(creator.token, `${label}-create`),
    payload: { attemptId: creatorAttempt.attempt.id },
  });
  assert.equal(createResponse.statusCode, 200, createResponse.body);
  const created = CreateChallengeResponseSchema.parse(createResponse.json());
  const challengeRows = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
      AND status = 'open'
  `;
  assert.equal(challengeRows.length, 1);
  const challengeId = challengeRows[0]!.id;

  const claimResponse = await harness.app.inject({
    method: "POST",
    url: `/v1/challenges/${created.challenge.token}/claim`,
    headers: idempotentHeaders(opponent.token, `${label}-claim`),
    payload: {},
  });
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  const claimed = ClaimChallengeResponseSchema.parse(claimResponse.json());

  let opponentAttemptId: string;
  if (options.immediate) {
    assert.equal(claimed.challenge.status, "completed");
    assert.ok(completedOpponentAttempt);
    opponentAttemptId = completedOpponentAttempt.attempt.id;
    assert.equal(claimed.daily.attempt.id, opponentAttemptId);
  } else {
    assert.equal(claimed.challenge.status, "claimed");
    const completed = await finishQuiz(
      opponent,
      `${label}-opponent`,
      2,
      claimed.daily,
    );
    opponentAttemptId = completed.attempt.id;
  }

  if (options.replayCompletion) {
    const replay = await harness.app.inject({
      method: "POST",
      url: `/v1/attempts/${opponentAttemptId}/complete`,
      headers: idempotentHeaders(opponent.token, `${label}-complete-replay`),
      payload: {},
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(parseCompletedAttempt(replay.json()).score, 2);
  }

  return {
    challengeId,
    publicToken: created.challenge.token,
    creator,
    opponent,
  };
}

async function getOutboxRows(challengeId: string): Promise<OutboxRow[]> {
  return harness.database.client<OutboxRow[]>`
    SELECT
      id,
      challenge_id,
      dedupe_key,
      status::text AS status,
      available_at,
      attempt_count::int AS attempt_count,
      last_error,
      published_at
    FROM notification_outbox
    WHERE challenge_id = ${challengeId}
    ORDER BY id
  `;
}

async function makeAvailable(challengeId: string): Promise<void> {
  await harness.database.client`
    UPDATE notification_outbox
    SET available_at = ${WORKER_AT.toISOString()}
    WHERE challenge_id = ${challengeId}
      AND status = 'pending'
  `;
}

function createRecordingSender(options?: { fail?: boolean }): {
  sender: NotificationSender;
  callIds: string[];
} {
  const callIds: string[] = [];
  return {
    callIds,
    sender: {
      async send(input: SendNotificationInput): Promise<void> {
        callIds.push(input.challengeId);
        if (options?.fail) {
          throw new Error("deterministic fake delivery failure");
        }
      },
    },
  };
}

function assertOnlyChallengeIds(
  callIds: readonly string[],
  expectedIds: readonly string[],
): void {
  assert.deepEqual([...callIds].sort(), [...expectedIds].sort());
}

async function waitForUserRowLock(userId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await harness.database.client.begin(async (transaction) => {
        await transaction`
          SELECT id
          FROM users
          WHERE id = ${userId}
          FOR UPDATE NOWAIT
        `;
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "55P03"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }

  assert.fail("preference update did not acquire the user row lock");
}

test("completion enqueue is consent-gated, minimal, deduplicated, and publishable", async () => {
  const disabled = await createCompletedChallenge("disabled", {
    notificationsEnabled: false,
  });
  assert.equal((await getOutboxRows(disabled.challengeId)).length, 0);

  const sensitiveNickname = "민감별명-outbox";
  const normal = await createCompletedChallenge("normal", {
    replayCompletion: true,
    creatorNickname: sensitiveNickname,
  });
  const immediate = await createCompletedChallenge("immediate", {
    immediate: true,
  });

  for (const fixture of [normal, immediate]) {
    const rows = await getOutboxRows(fixture.challengeId);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.dedupe_key,
      `challenge.completed:${fixture.challengeId}`,
    );
    assert.equal(rows[0]!.status, "pending");
  }

  const columnRows = await harness.database.client<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notification_outbox'
    ORDER BY column_name
  `;
  const columns = columnRows.map((row) => row.column_name);
  assert.deepEqual(columns, [
    "attempt_count",
    "available_at",
    "challenge_id",
    "dedupe_key",
    "event_type",
    "id",
    "last_error",
    "occurred_at",
    "published_at",
    "recipient_user_id",
    "status",
  ]);
  assert.equal(
    columns.some((column) =>
      /anon|token|nickname|score|payload|context|link/i.test(column),
    ),
    false,
  );

  const serializedRows = await harness.database.client<{ data: string }[]>`
    SELECT row_to_json(notification_outbox)::text AS data
    FROM notification_outbox
    WHERE challenge_id IN (${normal.challengeId}, ${immediate.challengeId})
    ORDER BY challenge_id
  `;
  assert.equal(serializedRows.length, 2);
  const forbiddenRawValues = [
    normal.creator.anonymousKey,
    normal.creator.token,
    normal.publicToken,
    sensitiveNickname,
    immediate.creator.anonymousKey,
    immediate.creator.token,
    immediate.publicToken,
  ];
  for (const row of serializedRows) {
    for (const rawValue of forbiddenRawValues) {
      assert.equal(row.data.includes(rawValue), false);
    }
  }

  await Promise.all([
    makeAvailable(normal.challengeId),
    makeAvailable(immediate.challengeId),
  ]);
  const recording = createRecordingSender();
  const counts = await runNotificationWorker(
    harness.database,
    recording.sender,
    {
      now: WORKER_AT,
    },
  );
  assert.deepEqual(counts, { ...zeroCounts, published: 2 });
  assertOnlyChallengeIds(recording.callIds, [
    normal.challengeId,
    immediate.challengeId,
  ]);
  for (const fixture of [normal, immediate]) {
    const row = (await getOutboxRows(fixture.challengeId))[0]!;
    assert.equal(row.status, "published");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.last_error, null);
    assert.equal(
      new Date(row.published_at!).toISOString(),
      WORKER_AT.toISOString(),
    );
  }
});

test("notification delivery kill switch suppresses enqueue without changing eligibility", async () => {
  const completed = await createCompletedChallenge("delivery-kill", {});
  await harness.database.client`
    DELETE FROM notification_outbox
    WHERE challenge_id = ${completed.challengeId}
  `;

  await harness.database.client.begin((transaction) =>
    enqueueChallengeCompletionNotifications(
      transaction,
      [completed.challengeId],
      false,
    ),
  );
  assert.equal((await getOutboxRows(completed.challengeId)).length, 0);

  await harness.database.client.begin((transaction) =>
    enqueueChallengeCompletionNotifications(
      transaction,
      [completed.challengeId],
      true,
    ),
  );
  assert.equal((await getOutboxRows(completed.challengeId)).length, 1);
  await harness.database.client`
    DELETE FROM notification_outbox
    WHERE challenge_id = ${completed.challengeId}
  `;
});

test("worker defaults to a batch of fifty and reports exact counts", async () => {
  const fixture = await createCompletedChallenge("default-batch");
  await makeAvailable(fixture.challengeId);
  await harness.database.client`
    INSERT INTO notification_outbox (
      event_type,
      recipient_user_id,
      challenge_id,
      dedupe_key,
      available_at,
      occurred_at
    )
    SELECT
      event_type,
      recipient_user_id,
      challenge_id,
      dedupe_key || ':batch-fixture:' || series::text,
      ${WORKER_AT.toISOString()},
      occurred_at
    FROM notification_outbox
    CROSS JOIN generate_series(1, 50) AS series
    WHERE challenge_id = ${fixture.challengeId}
      AND dedupe_key = ${`challenge.completed:${fixture.challengeId}`}
  `;

  const recording = createRecordingSender();
  const first = await runNotificationWorker(
    harness.database,
    recording.sender,
    {
      now: WORKER_AT,
    },
  );
  assert.deepEqual(first, { ...zeroCounts, published: 50 });
  assert.equal(recording.callIds.length, 50);
  assert.equal(
    recording.callIds.every((id) => id === fixture.challengeId),
    true,
  );

  const afterFirst = await getOutboxRows(fixture.challengeId);
  assert.equal(afterFirst.length, 51);
  assert.equal(
    afterFirst.filter((row) => row.status === "published").length,
    50,
  );
  assert.equal(afterFirst.filter((row) => row.status === "pending").length, 1);

  const second = await runNotificationWorker(
    harness.database,
    recording.sender,
    {
      now: WORKER_AT,
    },
  );
  assert.deepEqual(second, { ...zeroCounts, published: 1 });
  assert.equal(recording.callIds.length, 51);
  assert.equal(
    (await getOutboxRows(fixture.challengeId)).every(
      (row) => row.status === "published",
    ),
    true,
  );
});

test("concurrent workers lock one pending delivery", async () => {
  const fixture = await createCompletedChallenge("worker-race");
  await makeAvailable(fixture.challengeId);

  let announceSend!: () => void;
  let releaseSend!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    announceSend = resolve;
  });
  const sendReleased = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const callIds: string[] = [];
  const sender: NotificationSender = {
    async send(input: SendNotificationInput): Promise<void> {
      callIds.push(input.challengeId);
      announceSend();
      await sendReleased;
    },
  };

  const firstWorker = runNotificationWorker(harness.database, sender, {
    now: WORKER_AT,
  });
  await sendStarted;
  const secondCounts = await runNotificationWorker(harness.database, sender, {
    now: WORKER_AT,
  });
  assert.deepEqual(secondCounts, zeroCounts);
  releaseSend();
  const firstCounts = await firstWorker;

  assert.deepEqual(firstCounts, { ...zeroCounts, published: 1 });
  assert.deepEqual(callIds, [fixture.challengeId]);
  assert.equal(
    (await getOutboxRows(fixture.challengeId))[0]!.status,
    "published",
  );
});

test("opt-out waits for an in-flight delivery and fences later workers", async () => {
  const fixture = await createCompletedChallenge("opt-out-race");
  await makeAvailable(fixture.challengeId);

  let announceSend!: () => void;
  let releaseSend!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    announceSend = resolve;
  });
  const sendReleased = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const callIds: string[] = [];
  const sender: NotificationSender = {
    async send(input: SendNotificationInput): Promise<void> {
      callIds.push(input.challengeId);
      announceSend();
      await sendReleased;
    },
  };

  const worker = runNotificationWorker(harness.database, sender, {
    now: WORKER_AT,
  });
  await sendStarted;

  let optOutCompleted = false;
  const optOut = disableNotifications(fixture.creator).then(() => {
    optOutCompleted = true;
  });
  try {
    await waitForUserRowLock(fixture.creator.userId);
    assert.equal(optOutCompleted, false);
  } finally {
    releaseSend();
  }
  const workerCounts = await worker;
  assert.deepEqual(workerCounts, { ...zeroCounts, published: 1 });
  await optOut;
  assert.equal(optOutCompleted, true);
  assert.deepEqual(callIds, [fixture.challengeId]);

  const laterCounts = await runNotificationWorker(harness.database, sender, {
    now: new Date("2031-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(laterCounts, zeroCounts);
  assert.deepEqual(callIds, [fixture.challengeId]);
});

test("retryable failures back off and become terminal on attempt ten", async () => {
  const fixture = await createCompletedChallenge("retry-limit");
  await makeAvailable(fixture.challengeId);
  const recording = createRecordingSender({ fail: true });
  let now = new Date(WORKER_AT);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const counts = await runNotificationWorker(
      harness.database,
      recording.sender,
      {
        now,
      },
    );
    const row = (await getOutboxRows(fixture.challengeId))[0]!;
    assert.equal(row.attempt_count, attempt);
    assert.equal(row.last_error, "delivery_failed");

    if (attempt < 10) {
      assert.deepEqual(counts, { ...zeroCounts, retried: 1 });
      const expectedAvailableAt = new Date(
        now.getTime() + 60_000 * 2 ** (attempt - 1),
      );
      assert.equal(
        new Date(row.available_at).toISOString(),
        expectedAvailableAt.toISOString(),
      );
      assert.equal(row.status, "pending");
      now = expectedAvailableAt;
    } else {
      assert.deepEqual(counts, { ...zeroCounts, failed: 1 });
      assert.equal(row.status, "failed");
    }
  }

  assert.equal(recording.callIds.length, 10);
  assert.equal(
    recording.callIds.every((id) => id === fixture.challengeId),
    true,
  );
  const afterTerminal = await runNotificationWorker(
    harness.database,
    recording.sender,
    { now: new Date("2031-01-01T00:00:00.000Z") },
  );
  assert.deepEqual(afterTerminal, zeroCounts);
  assert.equal(recording.callIds.length, 10);
});

test("revoked, deleted, and redacted recipients are skipped without sending", async () => {
  const revoked = await createCompletedChallenge("skip-revoked");
  const deletedRace = await createCompletedChallenge("skip-deleted-race");
  const redacted = await createCompletedChallenge("skip-redacted");
  await Promise.all([
    makeAvailable(revoked.challengeId),
    makeAvailable(deletedRace.challengeId),
    makeAvailable(redacted.challengeId),
  ]);

  await disableNotifications(revoked.creator);
  await harness.database.client`
    UPDATE users
    SET
      identity_status = 'deleted',
      deleted_at = ${WORKER_AT.toISOString()},
      nickname = '탈퇴한 사용자',
      updated_at = ${WORKER_AT.toISOString()}
    WHERE id = ${deletedRace.creator.userId}
  `;
  await harness.database.client`
    UPDATE challenges
    SET
      result_redacted_at = ${WORKER_AT.toISOString()},
      creator_score = NULL,
      creator_nickname_snapshot = NULL,
      opponent_score = NULL,
      opponent_nickname_snapshot = NULL,
      updated_at = ${WORKER_AT.toISOString()}
    WHERE id = ${redacted.challengeId}
  `;

  const recording = createRecordingSender();
  const counts = await runNotificationWorker(
    harness.database,
    recording.sender,
    {
      now: WORKER_AT,
    },
  );
  assert.deepEqual(counts, { ...zeroCounts, skipped: 3 });
  assert.deepEqual(recording.callIds, []);

  for (const fixture of [revoked, deletedRace, redacted]) {
    const row = (await getOutboxRows(fixture.challengeId))[0]!;
    assert.equal(row.status, "failed");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.last_error, "recipient_ineligible");
    assert.equal(row.published_at, null);
  }
});

test("account deletion removes an unsent recipient outbox", async () => {
  const fixture = await createCompletedChallenge("account-delete");
  assert.equal((await getOutboxRows(fixture.challengeId)).length, 1);

  const deletion = await harness.app.inject({
    method: "DELETE",
    url: "/v1/me",
    headers: authorizationHeaders(fixture.creator.token),
    payload: { confirmation: "DELETE" },
  });
  assert.equal(deletion.statusCode, 200, deletion.body);
  assert.equal((await getOutboxRows(fixture.challengeId)).length, 0);

  const recording = createRecordingSender();
  const counts = await runNotificationWorker(
    harness.database,
    recording.sender,
    {
      now: new Date("2031-01-01T00:00:00.000Z"),
    },
  );
  assert.deepEqual(counts, zeroCounts);
  assert.deepEqual(recording.callIds, []);
});

test("worker terminally skips a pending event whose daily set was voided", async () => {
  const fixture = await createCompletedChallenge("voided-worker");
  await makeAvailable(fixture.challengeId);
  const setRows = await harness.database.client<{ daily_set_id: string }[]>`
    SELECT daily_set_id
    FROM challenges
    WHERE id = ${fixture.challengeId}
  `;
  const dailySetId = setRows[0]!.daily_set_id;
  await harness.database.client`
    INSERT INTO daily_set_voids (
      daily_set_id,
      actor_subject,
      reason,
      voided_at
    )
    VALUES (
      ${dailySetId},
      'outbox-integration-operator',
      '결과 알림 중단 검증',
      ${WORKER_AT.toISOString()}
    )
  `;

  const recording = createRecordingSender();
  const counts = await runNotificationWorker(
    harness.database,
    recording.sender,
    { now: WORKER_AT },
  );
  assert.deepEqual(counts, { ...zeroCounts, skipped: 1 });
  assert.deepEqual(recording.callIds, []);

  const row = (await getOutboxRows(fixture.challengeId))[0]!;
  assert.equal(row.status, "failed");
  assert.equal(row.last_error, "daily_set_voided");
  assert.equal(row.attempt_count, 0);
  assert.equal(row.published_at, null);
});
