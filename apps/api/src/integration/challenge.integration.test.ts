import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  ChallengeLandingResponseSchema,
  ChallengeResultResponseSchema,
  ClaimChallengeResponseSchema,
  CompleteAttemptResponseSchema,
  CreateChallengeResponseSchema,
  DailyStartResponseSchema,
  type CompletedAttemptResponse,
  type CreateChallengeResponse,
  type DailyAvailableStartResponse,
} from "@daily-quiz-battle/contracts";
import { decodeJwt } from "jose";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/client.js";
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
  token: string;
  userId: string;
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

function expectFeatureDisabled(response: JsonResponse): void {
  assert.equal(response.statusCode, 503, response.body);
  const error = ApiErrorSchema.parse(response.json());
  assert.equal(error.code, "FEATURE_DISABLED");
  assert.equal(error.retryable, true);
}

function getTokenUserId(token: string): string {
  const userId = decodeJwt(token).sub;
  assert.ok(userId, "issued access token must contain a subject");
  return userId;
}

async function bootstrapUser(identity: string): Promise<TestUser> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey: `dev-challenge-it-${identity}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  const token = BootstrapResponseSchema.parse(response.json()).accessToken;
  return { token, userId: getTokenUserId(token) };
}

async function startQuiz(token: string): Promise<DailyAvailableStartResponse> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/daily/start",
    headers: authorizationHeaders(token),
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
  keyPrefix: string,
  expectedScore: number,
  existingStart?: DailyAvailableStartResponse,
): Promise<DailyAvailableStartResponse> {
  const start = existingStart ?? (await startQuiz(user.token));
  for (const [index, question] of start.questions.entries()) {
    const correctIndex = correctSelections[index]!;
    const selectedIndex =
      index < expectedScore ? correctIndex : (correctIndex + 1) % 4;
    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/attempts/${start.attempt.id}/answers`,
      headers: idempotentHeaders(
        user.token,
        `${keyPrefix}-answer-${index + 1}`,
      ),
      payload: {
        sequence: question.sequence,
        questionRevisionId: question.revisionId,
        selectedIndex,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  const completion = await harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${start.attempt.id}/complete`,
    headers: idempotentHeaders(user.token, `${keyPrefix}-complete`),
    payload: {},
  });
  assert.equal(completion.statusCode, 200, completion.body);
  const completed = parseCompletedAttempt(completion.json());
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
  token: string,
  idempotencyKey: string,
) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/challenges/${token}/claim`,
    headers: idempotentHeaders(user.token, idempotencyKey),
    payload: {},
  });
}

async function getLanding(user: TestUser, token: string) {
  return harness.app.inject({
    method: "GET",
    url: `/v1/challenges/${token}`,
    headers: authorizationHeaders(user.token),
  });
}

async function getResult(user: TestUser, token: string) {
  return harness.app.inject({
    method: "GET",
    url: `/v1/challenges/${token}/result`,
    headers: authorizationHeaders(user.token),
  });
}

function tamperToken(token: string): string {
  return `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
}

interface MutationRowCounts {
  challenge_count: number;
  idempotency_count: number;
  attempt_count: number;
}

async function getMutationRowCounts(): Promise<MutationRowCounts> {
  const [counts] = await harness.database.client<MutationRowCounts[]>`
    SELECT
      (SELECT count(*)::int FROM challenges) AS challenge_count,
      (SELECT count(*)::int FROM idempotency_records) AS idempotency_count,
      (SELECT count(*)::int FROM attempts) AS attempt_count
  `;
  assert.ok(counts);
  return counts;
}

test("create kill switch blocks only create and preserves claim and reads", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("create-disabled-creator");
  const creatorAttempt = await finishQuiz(
    creator,
    "create-disabled-creator",
    3,
  );
  const created = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "create-disabled-fixture-create",
  );
  const claimant = await bootstrapUser("create-disabled-claimant");
  const disabledConfig = {
    ...harness.config,
    challengeCreateEnabled: false,
  };
  assert.equal(disabledConfig.challengeClaimEnabled, undefined);
  assert.equal(disabledConfig.dailyStartEnabled, undefined);
  assert.equal(disabledConfig.dailyContinuationEnabled, undefined);

  const disabledDatabase = createDatabase(disabledConfig);
  let disabledApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    disabledApp = await buildApp({
      config: disabledConfig,
      database: disabledDatabase,
      clock: () => new Date(PRIMARY_DAY_NOON),
    });

    const dailyStartResponse = await disabledApp.inject({
      method: "POST",
      url: "/v1/daily/start",
      headers: authorizationHeaders(claimant.token),
      payload: {},
    });
    assert.equal(dailyStartResponse.statusCode, 200, dailyStartResponse.body);
    assert.equal(
      DailyStartResponseSchema.parse(dailyStartResponse.json()).status,
      "available",
    );

    const countsBefore = await getMutationRowCounts();

    const blockedCreate = await disabledApp.inject({
      method: "POST",
      url: "/v1/challenges",
      headers: idempotentHeaders(
        creator.token,
        "create-disabled-blocked-create",
      ),
      payload: { attemptId: creatorAttempt.attempt.id },
    });
    expectFeatureDisabled(blockedCreate);

    const malformedAuthenticatedCreate = await disabledApp.inject({
      method: "POST",
      url: "/v1/challenges",
      headers: authorizationHeaders(creator.token),
      payload: {},
    });
    expectFeatureDisabled(malformedAuthenticatedCreate);

    const unauthenticatedCreate = await disabledApp.inject({
      method: "POST",
      url: "/v1/challenges",
      payload: {},
    });
    expectApiError(unauthenticatedCreate, 401, "UNAUTHORIZED");

    const creatorLandingResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}`,
      headers: authorizationHeaders(creator.token),
    });
    assert.equal(
      creatorLandingResponse.statusCode,
      200,
      creatorLandingResponse.body,
    );
    const creatorLanding = ChallengeLandingResponseSchema.parse(
      creatorLandingResponse.json(),
    );
    assert.equal(creatorLanding.status, "open");
    assert.equal(creatorLanding.viewerRole, "creator");
    assert.equal(/score/i.test(creatorLandingResponse.body), false);

    const outsiderLandingResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}`,
      headers: authorizationHeaders(claimant.token),
    });
    assert.equal(
      outsiderLandingResponse.statusCode,
      200,
      outsiderLandingResponse.body,
    );
    const outsiderLanding = ChallengeLandingResponseSchema.parse(
      outsiderLandingResponse.json(),
    );
    assert.equal(outsiderLanding.status, "open");
    assert.equal(outsiderLanding.viewerRole, "none");
    assert.equal(/score/i.test(outsiderLandingResponse.body), false);

    const resultResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}/result`,
      headers: authorizationHeaders(creator.token),
    });
    assert.equal(resultResponse.statusCode, 200, resultResponse.body);
    const result = ChallengeResultResponseSchema.parse(resultResponse.json());
    assert.equal(result.status, "open");
    assert.equal(result.viewerRole, "creator");
    assert.equal(result.me.score, 3);
    assert.equal(result.opponent.completed, false);
    assert.deepEqual(Object.keys(result.opponent).sort(), [
      "completed",
      "nickname",
    ]);

    assert.deepEqual(await getMutationRowCounts(), countsBefore);

    const claimResponse = await disabledApp.inject({
      method: "POST",
      url: `/v1/challenges/${created.challenge.token}/claim`,
      headers: idempotentHeaders(claimant.token, "create-disabled-claim"),
      payload: {},
    });
    assert.equal(claimResponse.statusCode, 200, claimResponse.body);
    const claim = ClaimChallengeResponseSchema.parse(claimResponse.json());
    assert.equal(claim.challenge.status, "claimed");

    const claimedLandingResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}`,
      headers: authorizationHeaders(claimant.token),
    });
    assert.equal(
      claimedLandingResponse.statusCode,
      200,
      claimedLandingResponse.body,
    );
    const claimedLanding = ChallengeLandingResponseSchema.parse(
      claimedLandingResponse.json(),
    );
    assert.equal(claimedLanding.status, "claimed");
    assert.equal(claimedLanding.viewerRole, "opponent");

    const claimedResultResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}/result`,
      headers: authorizationHeaders(claimant.token),
    });
    assert.equal(
      claimedResultResponse.statusCode,
      200,
      claimedResultResponse.body,
    );
    const claimedResult = ChallengeResultResponseSchema.parse(
      claimedResultResponse.json(),
    );
    assert.equal(claimedResult.status, "claimed");
    assert.equal(claimedResult.viewerRole, "opponent");
  } finally {
    if (disabledApp !== undefined) {
      await disabledApp.close();
    } else {
      await disabledDatabase.close();
    }
  }
});

test("claim kill switch blocks only claim and preserves create and reads", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("claim-disabled-creator");
  const creatorAttempt = await finishQuiz(creator, "claim-disabled-creator", 4);
  const claimant = await bootstrapUser("claim-disabled-claimant");
  const disabledConfig = {
    ...harness.config,
    challengeClaimEnabled: false,
  };
  assert.equal(disabledConfig.challengeCreateEnabled, undefined);

  const disabledDatabase = createDatabase(disabledConfig);
  let disabledApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    disabledApp = await buildApp({
      config: disabledConfig,
      database: disabledDatabase,
      clock: () => new Date(PRIMARY_DAY_NOON),
    });

    const createResponse = await disabledApp.inject({
      method: "POST",
      url: "/v1/challenges",
      headers: idempotentHeaders(creator.token, "claim-disabled-create"),
      payload: { attemptId: creatorAttempt.attempt.id },
    });
    assert.equal(createResponse.statusCode, 200, createResponse.body);
    const created = CreateChallengeResponseSchema.parse(createResponse.json());

    const landingResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}`,
      headers: authorizationHeaders(claimant.token),
    });
    assert.equal(landingResponse.statusCode, 200, landingResponse.body);
    const landing = ChallengeLandingResponseSchema.parse(
      landingResponse.json(),
    );
    assert.equal(landing.status, "open");
    assert.equal(landing.viewerRole, "none");
    assert.equal(/score/i.test(landingResponse.body), false);

    const resultResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}/result`,
      headers: authorizationHeaders(creator.token),
    });
    assert.equal(resultResponse.statusCode, 200, resultResponse.body);
    const result = ChallengeResultResponseSchema.parse(resultResponse.json());
    assert.equal(result.status, "open");
    assert.equal(result.viewerRole, "creator");
    assert.equal(result.me.score, 4);
    assert.equal(result.opponent.completed, false);

    const countsBefore = await getMutationRowCounts();
    const blockedClaim = await disabledApp.inject({
      method: "POST",
      url: `/v1/challenges/${created.challenge.token}/claim`,
      headers: idempotentHeaders(claimant.token, "claim-disabled-claim"),
      payload: {},
    });
    expectFeatureDisabled(blockedClaim);

    const malformedAuthenticatedClaim = await disabledApp.inject({
      method: "POST",
      url: `/v1/challenges/${created.challenge.token}/claim`,
      headers: authorizationHeaders(claimant.token),
      payload: {},
    });
    expectFeatureDisabled(malformedAuthenticatedClaim);

    const unauthenticatedClaim = await disabledApp.inject({
      method: "POST",
      url: `/v1/challenges/${created.challenge.token}/claim`,
      payload: {},
    });
    expectApiError(unauthenticatedClaim, 401, "UNAUTHORIZED");
    assert.deepEqual(await getMutationRowCounts(), countsBefore);

    const unchangedLandingResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}`,
      headers: authorizationHeaders(creator.token),
    });
    assert.equal(
      unchangedLandingResponse.statusCode,
      200,
      unchangedLandingResponse.body,
    );
    const unchangedLanding = ChallengeLandingResponseSchema.parse(
      unchangedLandingResponse.json(),
    );
    assert.equal(unchangedLanding.status, "open");
    assert.equal(unchangedLanding.viewerRole, "creator");

    const unchangedResultResponse = await disabledApp.inject({
      method: "GET",
      url: `/v1/challenges/${created.challenge.token}/result`,
      headers: authorizationHeaders(creator.token),
    });
    assert.equal(
      unchangedResultResponse.statusCode,
      200,
      unchangedResultResponse.body,
    );
    const unchangedResult = ChallengeResultResponseSchema.parse(
      unchangedResultResponse.json(),
    );
    assert.equal(unchangedResult.status, "open");
    assert.equal(unchangedResult.viewerRole, "creator");
  } finally {
    if (disabledApp !== undefined) {
      await disabledApp.close();
    } else {
      await disabledDatabase.close();
    }
  }
});

test("create authorization, idempotency, and token storage", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("create-creator");
  const creatorAttempt = await finishQuiz(creator, "create-creator", 3);

  const created = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "challenge-create-replay-key",
  );
  const replayed = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "challenge-create-replay-key",
  );
  assert.deepEqual(replayed, created);

  const records = await harness.database.client<
    {
      public_token_hash: string;
      response_body: string;
      challenge_token_count: number;
    }[]
  >`
    SELECT
      c.public_token_hash,
      ir.response_body::text AS response_body,
      count(*) OVER ()::int AS challenge_token_count
    FROM idempotency_records ir
    JOIN challenges c ON c.id = ir.resource_id
    WHERE ir.user_id = ${creator.userId}
      AND ir.operation = 'challenge:create'
  `;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.challenge_token_count, 1);
  assert.match(records[0]!.public_token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(records[0]!.public_token_hash, created.challenge.token);
  assert.equal(
    records[0]!.response_body.includes(created.challenge.token),
    false,
  );
  assert.equal(records[0]!.response_body.includes('"token"'), false);

  const other = await bootstrapUser("create-other");
  const otherAttempt = await finishQuiz(other, "create-other", 1);
  const changedBody = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(creator.token, "challenge-create-replay-key"),
    payload: { attemptId: otherAttempt.attempt.id },
  });
  expectApiError(changedBody, 409, "IDEMPOTENCY_KEY_REUSED");

  const unfinished = await bootstrapUser("create-unfinished");
  const unfinishedAttempt = await startQuiz(unfinished.token);
  const incompleteCreate = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(unfinished.token, "challenge-unfinished-key"),
    payload: { attemptId: unfinishedAttempt.attempt.id },
  });
  expectApiError(incompleteCreate, 422, "ATTEMPT_NOT_COMPLETED");

  const foreignCreate = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(creator.token, "challenge-foreign-attempt-key"),
    payload: { attemptId: otherAttempt.attempt.id },
  });
  expectApiError(foreignCreate, 403, "FORBIDDEN");
});

test("quota excludes expired open and claimed challenges", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("quota-creator");
  const attempt = await finishQuiz(creator, "quota-creator", 4);
  const initial = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      createChallenge(creator, attempt.attempt.id, `quota-initial-${index}`),
    ),
  );

  const opponent = await bootstrapUser("quota-opponent");
  const claimedResponse = await claimChallenge(
    opponent,
    initial[0]!.challenge.token,
    "quota-opponent-claim",
  );
  assert.equal(claimedResponse.statusCode, 200, claimedResponse.body);
  assert.equal(
    ClaimChallengeResponseSchema.parse(claimedResponse.json()).challenge.status,
    "claimed",
  );

  const overLimit = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(creator.token, "quota-sixth-active"),
    payload: { attemptId: attempt.attempt.id },
  });
  expectApiError(overLimit, 422, "CHALLENGE_LIMIT_REACHED");

  harness.setNow(initial[0]!.challenge.expiresAt);
  for (let index = 0; index < 5; index += 1) {
    await createChallenge(
      creator,
      attempt.attempt.id,
      `quota-after-expiry-${index}`,
    );
  }
  const secondOverLimit = await harness.app.inject({
    method: "POST",
    url: "/v1/challenges",
    headers: idempotentHeaders(creator.token, "quota-after-expiry-sixth"),
    payload: { attemptId: attempt.attempt.id },
  });
  expectApiError(secondOverLimit, 422, "CHALLENGE_LIMIT_REACHED");

  const oldRows = await harness.database.client<
    { status: "open" | "claimed"; claimed_by_user_id: string | null }[]
  >`
    SELECT status::text AS status, claimed_by_user_id
    FROM challenges
    WHERE creator_attempt_id = ${attempt.attempt.id}
      AND expires_at <= ${initial[0]!.challenge.expiresAt}
    ORDER BY claimed_at NULLS LAST, id
  `;
  assert.equal(oldRows.length, 5);
  assert.equal(oldRows.filter((row) => row.status === "claimed").length, 1);
  assert.equal(oldRows.filter((row) => row.status === "open").length, 4);
  assert.equal(oldRows[0]!.claimed_by_user_id, opponent.userId);
});

test("landing privacy and invalid-token errors are stable", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("privacy-creator");
  const attempt = await finishQuiz(creator, "privacy-creator", 5);
  const created = await createChallenge(
    creator,
    attempt.attempt.id,
    "privacy-create-key",
  );
  const outsider = await bootstrapUser("privacy-outsider");

  const creatorLandingResponse = await getLanding(
    creator,
    created.challenge.token,
  );
  assert.equal(
    creatorLandingResponse.statusCode,
    200,
    creatorLandingResponse.body,
  );
  const creatorLanding = ChallengeLandingResponseSchema.parse(
    creatorLandingResponse.json(),
  );
  assert.equal(creatorLanding.viewerRole, "creator");
  assert.equal(/score/i.test(creatorLandingResponse.body), false);

  const outsiderLandingResponse = await getLanding(
    outsider,
    created.challenge.token,
  );
  assert.equal(
    outsiderLandingResponse.statusCode,
    200,
    outsiderLandingResponse.body,
  );
  const outsiderLanding = ChallengeLandingResponseSchema.parse(
    outsiderLandingResponse.json(),
  );
  assert.equal(outsiderLanding.viewerRole, "none");
  assert.equal(/score/i.test(outsiderLandingResponse.body), false);

  const selfClaim = await claimChallenge(
    creator,
    created.challenge.token,
    "privacy-self-claim",
  );
  expectApiError(selfClaim, 403, "SELF_CLAIM_FORBIDDEN");

  const tampered = tamperToken(created.challenge.token);
  const tamperedLanding = await getLanding(outsider, tampered);
  expectApiError(tamperedLanding, 404, "CHALLENGE_NOT_FOUND");
  const tamperedClaim = await claimChallenge(
    outsider,
    tampered,
    "privacy-tampered-claim",
  );
  expectApiError(tamperedClaim, 404, "CHALLENGE_NOT_FOUND");
  const tamperedResult = await getResult(creator, tampered);
  expectApiError(tamperedResult, 404, "CHALLENGE_NOT_FOUND");
});

test("twenty concurrent claims choose one replayable opponent", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("race-creator");
  const creatorAttempt = await finishQuiz(creator, "race-creator", 3);
  const created = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "race-create-key",
  );
  const contenders = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      bootstrapUser(`race-contender-${index}`),
    ),
  );

  const responses = await Promise.all(
    contenders.map((contender, index) =>
      claimChallenge(contender, created.challenge.token, `race-claim-${index}`),
    ),
  );
  const winners = responses
    .map((response, index) => ({ response, index }))
    .filter(({ response }) => response.statusCode === 200);
  assert.equal(winners.length, 1);
  for (const response of responses) {
    if (response.statusCode !== 200) {
      expectApiError(response, 409, "ALREADY_CLAIMED");
    }
  }

  const winner = winners[0]!;
  const winnerUser = contenders[winner.index]!;
  const firstClaim = ClaimChallengeResponseSchema.parse(winner.response.json());
  const replay = await claimChallenge(
    winnerUser,
    created.challenge.token,
    "race-winner-replay-different-key",
  );
  assert.equal(replay.statusCode, 200, replay.body);
  const replayedClaim = ClaimChallengeResponseSchema.parse(replay.json());
  assert.deepEqual(replayedClaim, firstClaim);

  const rows = await harness.database.client<
    {
      claimed_by_user_id: string | null;
      opponent_attempt_id: string | null;
    }[]
  >`
    SELECT
      claimed_by_user_id,
      opponent_attempt_id
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.claimed_by_user_id, winnerUser.userId);
  assert.ok(rows[0]!.opponent_attempt_id);
});

test("a completed same-set attempt completes on claim", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("precompleted-creator");
  const opponent = await bootstrapUser("precompleted-opponent");
  const creatorAttempt = await finishQuiz(creator, "precompleted-creator", 4);
  const opponentAttempt = await finishQuiz(
    opponent,
    "precompleted-opponent",
    2,
  );
  const created = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "precompleted-create-key",
  );

  const response = await claimChallenge(
    opponent,
    created.challenge.token,
    "precompleted-claim-key",
  );
  assert.equal(response.statusCode, 200, response.body);
  const claimed = ClaimChallengeResponseSchema.parse(response.json());
  assert.equal(claimed.challenge.status, "completed");
  assert.equal(claimed.daily.attempt.id, opponentAttempt.attempt.id);
  assert.equal(claimed.daily.attempt.status, "completed");
  assert.equal(claimed.daily.attempt.score, 2);

  const rows = await harness.database.client<
    {
      status: string;
      opponent_attempt_id: string;
      opponent_score: number;
      completed_at: Date | string | null;
    }[]
  >`
    SELECT
      status::text AS status,
      opponent_attempt_id,
      opponent_score::int AS opponent_score,
      completed_at
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "completed");
  assert.equal(rows[0]!.opponent_attempt_id, opponentAttempt.attempt.id);
  assert.equal(rows[0]!.opponent_score, 2);
  assert.ok(rows[0]!.completed_at);
});

test("completion publishes participant-only win, loss, and draw", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("results-creator");
  const creatorAttempt = await finishQuiz(creator, "results-creator", 2);
  const outsider = await bootstrapUser("results-outsider");
  const cases = [
    { label: "creator-loss", opponentScore: 5, creatorOutcome: "loss" },
    { label: "creator-win", opponentScore: 0, creatorOutcome: "win" },
    { label: "draw", opponentScore: 2, creatorOutcome: "draw" },
  ] as const;

  for (const scenario of cases) {
    const opponent = await bootstrapUser(`results-${scenario.label}-opponent`);
    const created = await createChallenge(
      creator,
      creatorAttempt.attempt.id,
      `results-${scenario.label}-create`,
    );
    const claimResponse = await claimChallenge(
      opponent,
      created.challenge.token,
      `results-${scenario.label}-claim`,
    );
    assert.equal(claimResponse.statusCode, 200, claimResponse.body);
    const claim = ClaimChallengeResponseSchema.parse(claimResponse.json());
    assert.equal(claim.challenge.status, "claimed");

    const opponentLandingResponse = await getLanding(
      opponent,
      created.challenge.token,
    );
    assert.equal(
      opponentLandingResponse.statusCode,
      200,
      opponentLandingResponse.body,
    );
    assert.equal(
      ChallengeLandingResponseSchema.parse(opponentLandingResponse.json())
        .viewerRole,
      "opponent",
    );

    await finishQuiz(
      opponent,
      `results-${scenario.label}-opponent`,
      scenario.opponentScore,
      claim.daily,
    );

    const creatorResultResponse = await getResult(
      creator,
      created.challenge.token,
    );
    assert.equal(
      creatorResultResponse.statusCode,
      200,
      creatorResultResponse.body,
    );
    const creatorResult = ChallengeResultResponseSchema.parse(
      creatorResultResponse.json(),
    );
    assert.equal(creatorResult.status, "completed");
    if (creatorResult.status !== "completed") {
      assert.fail("creator result must be completed");
    }
    assert.equal(creatorResult.viewerRole, "creator");
    assert.equal(creatorResult.outcome, scenario.creatorOutcome);
    assert.equal(creatorResult.me.score, 2);
    assert.equal(creatorResult.opponent.score, scenario.opponentScore);

    const opponentResultResponse = await getResult(
      opponent,
      created.challenge.token,
    );
    assert.equal(
      opponentResultResponse.statusCode,
      200,
      opponentResultResponse.body,
    );
    const opponentResult = ChallengeResultResponseSchema.parse(
      opponentResultResponse.json(),
    );
    assert.equal(opponentResult.status, "completed");
    if (opponentResult.status !== "completed") {
      assert.fail("opponent result must be completed");
    }
    const expectedOpponentOutcome: "win" | "loss" | "draw" =
      scenario.creatorOutcome === "win"
        ? "loss"
        : scenario.creatorOutcome === "loss"
          ? "win"
          : "draw";
    assert.equal(opponentResult.viewerRole, "opponent");
    assert.equal(opponentResult.outcome, expectedOpponentOutcome);
    assert.equal(opponentResult.me.score, scenario.opponentScore);
    assert.equal(opponentResult.opponent.score, 2);

    const unauthorized = await getResult(outsider, created.challenge.token);
    expectApiError(unauthorized, 404, "CHALLENGE_NOT_FOUND");
  }
});

test("claiming an existing same-set attempt preserves the daily deadline", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("existing-deadline-creator");
  const creatorAttempt = await finishQuiz(
    creator,
    "existing-deadline-creator",
    3,
  );
  const created = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "existing-deadline-create",
  );
  const opponent = await bootstrapUser("existing-deadline-opponent");
  const existingAttempt = await startQuiz(opponent.token);

  const claimResponse = await claimChallenge(
    opponent,
    created.challenge.token,
    "existing-deadline-claim",
  );
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  const claimed = ClaimChallengeResponseSchema.parse(claimResponse.json());
  assert.equal(claimed.daily.attempt.id, existingAttempt.attempt.id);

  const provenanceRows = await harness.database.client<
    { challenge_id: string | null; claimed_challenge_id: string }[]
  >`
    SELECT
      a.challenge_id,
      c.id AS claimed_challenge_id
    FROM attempts a
    JOIN challenges c ON c.opponent_attempt_id = a.id
    WHERE a.id = ${existingAttempt.attempt.id}
  `;
  const provenance = provenanceRows[0];
  assert.ok(provenance);
  assert.equal(provenance.challenge_id, null);
  await assert.rejects(async () => {
    await harness.database.client`
        UPDATE attempts
        SET challenge_id = ${provenance.claimed_challenge_id}
        WHERE id = ${existingAttempt.attempt.id}
      `;
  }, /attempt challenge provenance is immutable/);

  harness.setNow(new Date("2026-08-29T16:00:00.000Z"));
  const question = existingAttempt.questions[0]!;
  const answerAtDailyDeadline = await harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${existingAttempt.attempt.id}/answers`,
    headers: idempotentHeaders(
      opponent.token,
      "existing-deadline-answer-at-boundary",
    ),
    payload: {
      sequence: question.sequence,
      questionRevisionId: question.revisionId,
      selectedIndex: correctSelections[0],
    },
  });
  expectApiError(answerAtDailyDeadline, 409, "ATTEMPT_ABANDONED");

  const abandonedRows = await harness.database.client<
    { status: string; challenge_id: string | null }[]
  >`
    SELECT status::text AS status, challenge_id
    FROM attempts
    WHERE id = ${existingAttempt.attempt.id}
  `;
  assert.equal(abandonedRows[0]?.status, "abandoned");
  assert.equal(abandonedRows[0]?.challenge_id, null);
});

test("historical challenge attempts use immutable provenance until challenge expiry", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("provenance-creator");
  const creatorAttempt = await finishQuiz(creator, "provenance-creator", 4);
  const created = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "provenance-create",
  );
  const challengeRows = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
  `;
  const challenge = challengeRows[0];
  assert.ok(challenge);

  harness.setNow(new Date("2026-08-29T16:00:00.001Z"));
  const opponent = await bootstrapUser("provenance-opponent");
  const claimResponse = await claimChallenge(
    opponent,
    created.challenge.token,
    "provenance-claim",
  );
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  const claimed = ClaimChallengeResponseSchema.parse(claimResponse.json());
  assert.equal(claimed.daily.attempt.status, "started");

  const attemptRows = await harness.database.client<
    { challenge_id: string | null; expires_at: Date | string | null }[]
  >`
    SELECT a.challenge_id, c.expires_at
    FROM attempts a
    LEFT JOIN challenges c ON c.id = a.challenge_id
    WHERE a.id = ${claimed.daily.attempt.id}
  `;
  const attempt = attemptRows[0];
  assert.equal(attempt?.challenge_id, challenge.id);
  const provenanceExpiresAt = attempt?.expires_at;
  assert.ok(provenanceExpiresAt);
  assert.equal(
    provenanceExpiresAt instanceof Date
      ? provenanceExpiresAt.toISOString()
      : new Date(provenanceExpiresAt).toISOString(),
    created.challenge.expiresAt,
  );

  const firstQuestion = claimed.daily.questions[0]!;
  const historicalAnswer = await harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${claimed.daily.attempt.id}/answers`,
    headers: idempotentHeaders(
      opponent.token,
      "provenance-answer-before-expiry",
    ),
    payload: {
      sequence: firstQuestion.sequence,
      questionRevisionId: firstQuestion.revisionId,
      selectedIndex: correctSelections[0],
    },
  });
  assert.equal(historicalAnswer.statusCode, 200, historicalAnswer.body);

  harness.setNow(new Date(created.challenge.expiresAt));
  const secondQuestion = claimed.daily.questions[1]!;
  const answerAtChallengeExpiry = await harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${claimed.daily.attempt.id}/answers`,
    headers: idempotentHeaders(opponent.token, "provenance-answer-at-expiry"),
    payload: {
      sequence: secondQuestion.sequence,
      questionRevisionId: secondQuestion.revisionId,
      selectedIndex: correctSelections[1],
    },
  });
  expectApiError(answerAtChallengeExpiry, 409, "ATTEMPT_ABANDONED");

  await harness.database.client`
    DELETE FROM challenges
    WHERE id = ${challenge.id}
  `;
  const clearedRows = await harness.database.client<
    { challenge_id: string | null }[]
  >`
    SELECT challenge_id
    FROM attempts
    WHERE id = ${claimed.daily.attempt.id}
  `;
  assert.equal(clearedRows[0]?.challenge_id, null);
});

test("expiry boundary expires open but preserves claimed state", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("expiry-creator");
  const creatorAttempt = await finishQuiz(creator, "expiry-creator", 3);
  const openChallenge = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "expiry-open-create",
  );
  const claimedChallenge = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "expiry-claimed-create",
  );
  assert.equal(
    openChallenge.challenge.expiresAt,
    claimedChallenge.challenge.expiresAt,
  );
  const opponent = await bootstrapUser("expiry-opponent");
  const claimResponse = await claimChallenge(
    opponent,
    claimedChallenge.challenge.token,
    "expiry-opponent-claim",
  );
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);

  const expiresAt = new Date(openChallenge.challenge.expiresAt);
  harness.setNow(new Date(expiresAt.getTime() - 1));
  const openBefore = await getLanding(creator, openChallenge.challenge.token);
  assert.equal(openBefore.statusCode, 200, openBefore.body);
  assert.equal(
    ChallengeLandingResponseSchema.parse(openBefore.json()).status,
    "open",
  );
  const openResultBefore = await getResult(
    creator,
    openChallenge.challenge.token,
  );
  assert.equal(openResultBefore.statusCode, 200, openResultBefore.body);
  assert.equal(
    ChallengeResultResponseSchema.parse(openResultBefore.json()).status,
    "open",
  );
  const claimedBefore = await getLanding(
    opponent,
    claimedChallenge.challenge.token,
  );
  assert.equal(claimedBefore.statusCode, 200, claimedBefore.body);
  assert.equal(
    ChallengeLandingResponseSchema.parse(claimedBefore.json()).status,
    "claimed",
  );

  harness.setNow(expiresAt);
  const openResultAtBoundary = await getResult(
    creator,
    openChallenge.challenge.token,
  );
  expectApiError(openResultAtBoundary, 404, "CHALLENGE_NOT_FOUND");
  const openAtBoundary = await getLanding(
    creator,
    openChallenge.challenge.token,
  );
  assert.equal(openAtBoundary.statusCode, 200, openAtBoundary.body);
  assert.equal(
    ChallengeLandingResponseSchema.parse(openAtBoundary.json()).status,
    "expired",
  );
  const lateClaimer = await bootstrapUser("expiry-late-claimer");
  const lateClaim = await claimChallenge(
    lateClaimer,
    openChallenge.challenge.token,
    "expiry-late-claim",
  );
  expectApiError(lateClaim, 404, "CHALLENGE_NOT_FOUND");
  const expiredOutsiderLanding = await getLanding(
    lateClaimer,
    openChallenge.challenge.token,
  );
  expectApiError(expiredOutsiderLanding, 404, "CHALLENGE_NOT_FOUND");

  const claimedAtBoundary = await getLanding(
    opponent,
    claimedChallenge.challenge.token,
  );
  assert.equal(claimedAtBoundary.statusCode, 200, claimedAtBoundary.body);
  assert.equal(
    ChallengeLandingResponseSchema.parse(claimedAtBoundary.json()).status,
    "claimed",
  );
  const preservedResultResponse = await getResult(
    opponent,
    claimedChallenge.challenge.token,
  );
  assert.equal(
    preservedResultResponse.statusCode,
    200,
    preservedResultResponse.body,
  );
  const preservedResult = ChallengeResultResponseSchema.parse(
    preservedResultResponse.json(),
  );
  assert.equal(preservedResult.status, "claimed");
  assert.equal(preservedResult.viewerRole, "opponent");

  const rows = await harness.database.client<
    {
      status: "expired" | "claimed";
      claimed_by_user_id: string | null;
      opponent_attempt_id: string | null;
    }[]
  >`
    SELECT
      status::text AS status,
      claimed_by_user_id,
      opponent_attempt_id
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
    ORDER BY created_at, id
  `;
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.status === "expired").length, 1);
  const claimedRow = rows.find((row) => row.status === "claimed");
  assert.equal(claimedRow?.claimed_by_user_id, opponent.userId);
  assert.ok(claimedRow?.opponent_attempt_id);
});

test("void overrides challenge replays and participant projections without rewriting snapshots", async () => {
  harness.setNow(PRIMARY_DAY_NOON);
  const creator = await bootstrapUser("void-creator");
  const creatorAttempt = await finishQuiz(creator, "void-creator", 4);
  const replayOpponent = await bootstrapUser("void-replay-opponent");
  const resultOpponent = await bootstrapUser("void-result-opponent");
  const resultOpponentAttempt = await finishQuiz(
    resultOpponent,
    "void-result-opponent",
    1,
  );
  const outsider = await bootstrapUser("void-outsider");

  const replayChallenge = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "void-create-old-key",
  );
  let challengeRows = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
  `;
  assert.equal(challengeRows.length, 1);
  const replayChallengeId = challengeRows[0]!.id;
  const firstClaim = await claimChallenge(
    replayOpponent,
    replayChallenge.challenge.token,
    "void-claim-old-key",
  );
  assert.equal(firstClaim.statusCode, 200, firstClaim.body);
  const firstClaimBody = ClaimChallengeResponseSchema.parse(firstClaim.json());
  assert.equal(firstClaimBody.challenge.status, "claimed");
  for (const [index, question] of firstClaimBody.daily.questions.entries()) {
    const answer = await harness.app.inject({
      method: "POST",
      url: `/v1/attempts/${firstClaimBody.daily.attempt.id}/answers`,
      headers: idempotentHeaders(
        replayOpponent.token,
        `void-replay-opponent-answer-${index + 1}`,
      ),
      payload: {
        sequence: question.sequence,
        questionRevisionId: question.revisionId,
        selectedIndex: correctSelections[index],
      },
    });
    assert.equal(answer.statusCode, 200, answer.body);
  }

  const completedChallenge = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "void-result-create",
  );
  challengeRows = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
  `;
  const completedChallengeId = challengeRows.find(
    (row) => row.id !== replayChallengeId,
  )?.id;
  assert.ok(completedChallengeId);
  const completedClaim = await claimChallenge(
    resultOpponent,
    completedChallenge.challenge.token,
    "void-result-claim",
  );
  assert.equal(completedClaim.statusCode, 200, completedClaim.body);
  const completedClaimBody = ClaimChallengeResponseSchema.parse(
    completedClaim.json(),
  );
  assert.equal(completedClaimBody.challenge.status, "completed");
  assert.equal(
    completedClaimBody.daily.attempt.id,
    resultOpponentAttempt.attempt.id,
  );
  await harness.database.client`
    UPDATE challenges
    SET result_redacted_at = ${"2026-08-29T03:01:00.000Z"}
    WHERE id = ${completedChallengeId}
  `;

  const expiredChallenge = await createChallenge(
    creator,
    creatorAttempt.attempt.id,
    "void-expired-create",
  );
  challengeRows = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM challenges
    WHERE creator_attempt_id = ${creatorAttempt.attempt.id}
  `;
  const knownIds = new Set([replayChallengeId, completedChallengeId]);
  const expiredChallengeId = challengeRows.find(
    (row) => !knownIds.has(row.id),
  )?.id;
  assert.ok(expiredChallengeId);
  harness.setNow(expiredChallenge.challenge.expiresAt);
  const expiredBeforeVoid = await getLanding(
    creator,
    expiredChallenge.challenge.token,
  );
  assert.equal(expiredBeforeVoid.statusCode, 200, expiredBeforeVoid.body);
  assert.equal(
    ChallengeLandingResponseSchema.parse(expiredBeforeVoid.json()).status,
    "expired",
  );

  const setRows = await harness.database.client<{ daily_set_id: string }[]>`
    SELECT daily_set_id
    FROM attempts
    WHERE id = ${creatorAttempt.attempt.id}
  `;
  const dailySetId = setRows[0]!.daily_set_id;
  const snapshotsBefore = await harness.database.client<
    { id: string; state: string }[]
  >`
    SELECT id, row_to_json(challenges)::text AS state
    FROM challenges
    WHERE id IN ${harness.database.client([
      replayChallengeId,
      completedChallengeId,
      expiredChallengeId,
    ])}
    ORDER BY id
  `;
  const scoresBefore = await harness.database.client<
    { id: string; score: number | null; status: string }[]
  >`
    SELECT id, score::int AS score, status::text AS status
    FROM attempts
    WHERE id IN ${harness.database.client([
      creatorAttempt.attempt.id,
      firstClaimBody.daily.attempt.id,
      resultOpponentAttempt.attempt.id,
    ])}
    ORDER BY id
  `;
  assert.deepEqual(
    scoresBefore.find((row) => row.id === firstClaimBody.daily.attempt.id),
    {
      id: firstClaimBody.daily.attempt.id,
      score: null,
      status: "started",
    },
  );

  const voidedAt = expiredChallenge.challenge.expiresAt;
  await harness.database.client`
    INSERT INTO daily_set_voids (
      daily_set_id,
      actor_subject,
      reason,
      voided_at
    )
    VALUES (
      ${dailySetId},
      'challenge-integration-operator',
      '문항 오류',
      ${voidedAt}
    )
  `;

  for (const key of ["void-create-old-key", "void-create-new-key"]) {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/challenges",
      headers: idempotentHeaders(creator.token, key),
      payload: { attemptId: creatorAttempt.attempt.id },
    });
    expectApiError(response, 409, "DAILY_SET_VOIDED");
    assert.doesNotMatch(response.body, /creatorScore|nickname|outcome/i);
    assert.equal(response.body.includes("문항 오류"), false);
  }
  for (const key of ["void-claim-old-key", "void-claim-new-key"]) {
    const response = await claimChallenge(
      replayOpponent,
      replayChallenge.challenge.token,
      key,
    );
    expectApiError(response, 409, "DAILY_SET_VOIDED");
    assert.doesNotMatch(response.body, /score|nickname|outcome/i);
    assert.equal(response.body.includes("문항 오류"), false);
  }

  const blockedCompletion = await harness.app.inject({
    method: "POST",
    url: `/v1/attempts/${firstClaimBody.daily.attempt.id}/complete`,
    headers: idempotentHeaders(
      replayOpponent.token,
      "void-replay-opponent-complete",
    ),
    payload: {},
  });
  assert.equal(blockedCompletion.statusCode, 200, blockedCompletion.body);
  const blockedCompletionBody = CompleteAttemptResponseSchema.parse(
    blockedCompletion.json(),
  );
  assert.equal(blockedCompletionBody.status, "voided");
  assert.doesNotMatch(
    blockedCompletion.body,
    /completedAt|review|score|total/i,
  );
  assert.equal(blockedCompletion.body.includes("문항 오류"), false);

  for (const viewer of [creator, replayOpponent, outsider]) {
    const response = await getLanding(viewer, replayChallenge.challenge.token);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    const projection = ChallengeLandingResponseSchema.parse(body);
    assert.equal(projection.status, "voided");
    assert.deepEqual(Object.keys(body as object).sort(), [
      "quizDate",
      "status",
      "viewerRole",
      "voidedAt",
    ]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /expiresAt|nickname|outcome|score/i,
    );
    assert.equal(
      response.body.includes("challenge-integration-operator"),
      false,
    );
    assert.equal(response.body.includes("문항 오류"), false);
  }

  for (const viewer of [creator, resultOpponent]) {
    const response = await getResult(
      viewer,
      completedChallenge.challenge.token,
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    const projection = ChallengeResultResponseSchema.parse(body);
    assert.equal(projection.status, "voided");
    assert.deepEqual(Object.keys(body as object).sort(), [
      "quizDate",
      "status",
      "viewerRole",
      "voidedAt",
    ]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /completedAt|nickname|outcome|score/i,
    );
    assert.equal(
      response.body.includes("challenge-integration-operator"),
      false,
    );
    assert.equal(response.body.includes("문항 오류"), false);
  }

  const outsiderResult = await getResult(
    outsider,
    replayChallenge.challenge.token,
  );
  expectApiError(outsiderResult, 404, "CHALLENGE_NOT_FOUND");
  const redactedOutsiderLanding = await getLanding(
    outsider,
    completedChallenge.challenge.token,
  );
  expectApiError(redactedOutsiderLanding, 404, "CHALLENGE_NOT_FOUND");
  const expiredOutsiderLanding = await getLanding(
    outsider,
    expiredChallenge.challenge.token,
  );
  expectApiError(expiredOutsiderLanding, 404, "CHALLENGE_NOT_FOUND");
  const expiredCreatorResult = await getResult(
    creator,
    expiredChallenge.challenge.token,
  );
  expectApiError(expiredCreatorResult, 404, "CHALLENGE_NOT_FOUND");
  const expiredClaim = await claimChallenge(
    outsider,
    expiredChallenge.challenge.token,
    "void-expired-claim",
  );
  expectApiError(expiredClaim, 404, "CHALLENGE_NOT_FOUND");

  const snapshotsAfter = await harness.database.client<
    { id: string; state: string }[]
  >`
    SELECT id, row_to_json(challenges)::text AS state
    FROM challenges
    WHERE id IN ${harness.database.client([
      replayChallengeId,
      completedChallengeId,
      expiredChallengeId,
    ])}
    ORDER BY id
  `;
  const scoresAfter = await harness.database.client<
    { id: string; score: number | null; status: string }[]
  >`
    SELECT id, score::int AS score, status::text AS status
    FROM attempts
    WHERE id IN ${harness.database.client([
      creatorAttempt.attempt.id,
      firstClaimBody.daily.attempt.id,
      resultOpponentAttempt.attempt.id,
    ])}
    ORDER BY id
  `;
  assert.deepEqual(snapshotsAfter, snapshotsBefore);
  assert.deepEqual(scoresAfter, scoresBefore);
});
