import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createDatabase } from "../db/client.js";
import {
  CLEANUP_BATCH_SIZE,
  runCleanup,
  type CleanupCounts,
} from "../maintenance/cleanup.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

const CLEANUP_NOW = new Date("2035-06-15T12:00:00.000Z");
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

interface ChallengeFixture {
  label: string;
  status: "open" | "claimed" | "completed" | "expired";
  expiresAt: Date;
  completedAt?: Date;
  resultRedactedAt?: Date;
  accountRedacted?: boolean;
}

interface ChallengeRow {
  id: string;
  status: "open" | "claimed" | "completed" | "expired";
  creator_score: number | null;
  creator_nickname_snapshot: string | null;
  opponent_score: number | null;
  opponent_nickname_snapshot: string | null;
  result_redacted_at: Date | string | null;
}

let harness: IntegrationHarness;
let dailySetId: string;
let creatorUserId: string;
let opponentUserId: string;
let creatorAttemptId: string;
let opponentAttemptId: string;

before(async () => {
  harness = await createIntegrationHarness();

  const dailySets = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM daily_sets
    ORDER BY quiz_date
    LIMIT 1
  `;
  dailySetId = dailySets[0]!.id;

  creatorUserId = await insertUser("creator");
  opponentUserId = await insertUser("opponent");
  creatorAttemptId = await insertAttempt(creatorUserId, 4);
  opponentAttemptId = await insertAttempt(opponentUserId, 2);
});

after(async () => {
  await harness?.close();
});

function shiftedNow(days: number, milliseconds = 0): Date {
  return new Date(
    CLEANUP_NOW.getTime() + days * DAY_IN_MILLISECONDS + milliseconds,
  );
}

function timestamp(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function fixtureHash(label: string): string {
  return createHash("sha256")
    .update(`cleanup-integration:${label}`)
    .digest("hex");
}

async function insertUser(label: string): Promise<string> {
  const id = randomUUID();
  const fingerprint = randomUUID().replaceAll("-", "").repeat(2);
  await harness.database.client`
    INSERT INTO users (
      id,
      anon_key_fingerprint,
      nickname,
      identity_verified_at,
      created_at,
      updated_at
    )
    VALUES (
      ${id},
      ${fingerprint},
      ${`정리-${label}`},
      ${timestamp(shiftedNow(-100))},
      ${timestamp(shiftedNow(-100))},
      ${timestamp(shiftedNow(-100))}
    )
  `;
  return id;
}

async function insertAttempt(userId: string, score: number): Promise<string> {
  const id = randomUUID();
  await harness.database.client`
    INSERT INTO attempts (
      id,
      user_id,
      daily_set_id,
      status,
      score,
      started_at,
      completed_at,
      updated_at
    )
    VALUES (
      ${id},
      ${userId},
      ${dailySetId},
      'completed',
      ${score},
      ${timestamp(shiftedNow(-100))},
      ${timestamp(shiftedNow(-100, 1))},
      ${timestamp(shiftedNow(-100, 1))}
    )
  `;
  return id;
}

async function insertChallenge(fixture: ChallengeFixture): Promise<string> {
  const id = randomUUID();
  const isClaimed =
    fixture.status === "claimed" || fixture.status === "completed";
  const isCompleted = fixture.status === "completed";
  const accountRedacted = fixture.accountRedacted ?? false;

  await harness.database.client`
    INSERT INTO challenges (
      id,
      public_token_hash,
      daily_set_id,
      creator_user_id,
      creator_attempt_id,
      creator_score,
      creator_nickname_snapshot,
      claimed_by_user_id,
      opponent_attempt_id,
      opponent_score,
      opponent_nickname_snapshot,
      status,
      claimed_at,
      completed_at,
      expires_at,
      result_redacted_at,
      created_at,
      updated_at
    )
    VALUES (
      ${id},
      ${fixtureHash(fixture.label)},
      ${dailySetId},
      ${accountRedacted ? null : creatorUserId},
      ${accountRedacted ? null : creatorAttemptId},
      ${accountRedacted ? null : 4},
      ${accountRedacted ? null : "정리생성자"},
      ${isClaimed ? opponentUserId : null},
      ${isClaimed ? opponentAttemptId : null},
      ${isCompleted ? 2 : null},
      ${isClaimed ? "정리상대방" : null},
      ${fixture.status}::challenge_status,
      ${isClaimed ? timestamp(shiftedNow(-40)) : null},
      ${timestamp(fixture.completedAt)},
      ${timestamp(fixture.expiresAt)},
      ${timestamp(fixture.resultRedactedAt)},
      ${timestamp(shiftedNow(-100))},
      ${timestamp(shiftedNow(-100))}
    )
  `;
  return id;
}

async function insertChallengeReport(challengeId: string): Promise<string> {
  const id = randomUUID();
  await harness.database.client`
    INSERT INTO reports (
      id,
      reporter_user_id,
      challenge_id,
      reason_code,
      created_at
    )
    VALUES (
      ${id},
      ${opponentUserId},
      ${challengeId},
      'other',
      ${timestamp(shiftedNow(-1))}
    )
  `;
  return id;
}

async function getChallenge(id: string): Promise<ChallengeRow | undefined> {
  const rows = await harness.database.client<ChallengeRow[]>`
    SELECT
      id,
      status::text AS status,
      creator_score::int AS creator_score,
      creator_nickname_snapshot,
      opponent_score::int AS opponent_score,
      opponent_nickname_snapshot,
      result_redacted_at
    FROM challenges
    WHERE id = ${id}
  `;
  return rows[0];
}

function assertSnapshotsRedacted(row: ChallengeRow): void {
  assert.equal(row.creator_score, null);
  assert.equal(row.creator_nickname_snapshot, null);
  assert.equal(row.opponent_score, null);
  assert.equal(row.opponent_nickname_snapshot, null);
}

function assertFullyRedacted(row: ChallengeRow): void {
  assertSnapshotsRedacted(row);
  assert.equal(
    new Date(row.result_redacted_at!).toISOString(),
    CLEANUP_NOW.toISOString(),
  );
}

function zeroCounts(): CleanupCounts {
  return {
    challengesExpired: 0,
    challengesPurged: 0,
    claimedChallengesRedacted: 0,
    claimedChallengesPurged: 0,
    completedChallengesRedacted: 0,
    idempotencyRecordsDeleted: 0,
  };
}

test("cleanup enforces retention, redaction, report correlation preservation, and idempotency", async () => {
  const openDue = await insertChallenge({
    label: "open-due",
    status: "open",
    expiresAt: CLEANUP_NOW,
  });
  const openFuture = await insertChallenge({
    label: "open-future",
    status: "open",
    expiresAt: shiftedNow(0, 1),
  });
  const expiredWithinRetention = await insertChallenge({
    label: "expired-within-retention",
    status: "expired",
    expiresAt: shiftedNow(-7, 1),
  });
  const expiredPastRetention = await insertChallenge({
    label: "expired-past-retention",
    status: "expired",
    expiresAt: shiftedNow(-7, -1),
  });
  const reportedExpiredPastRetention = await insertChallenge({
    label: "reported-expired-past-retention",
    status: "expired",
    expiresAt: shiftedNow(-8),
  });
  const expiredChallengeReportId = await insertChallengeReport(
    reportedExpiredPastRetention,
  );

  const claimedReported = await insertChallenge({
    label: "claimed-reported",
    status: "claimed",
    expiresAt: shiftedNow(-30, -1),
  });
  const claimedChallengeReportId = await insertChallengeReport(claimedReported);
  const claimedUnreported = await insertChallenge({
    label: "claimed-unreported",
    status: "claimed",
    expiresAt: shiftedNow(-31),
  });
  const claimedWithinRetention = await insertChallenge({
    label: "claimed-within-retention",
    status: "claimed",
    expiresAt: shiftedNow(-30, 1),
  });

  const completedPastRetention = await insertChallenge({
    label: "completed-past-retention",
    status: "completed",
    expiresAt: shiftedNow(-40),
    completedAt: shiftedNow(-30, -1),
  });
  const completedWithinRetention = await insertChallenge({
    label: "completed-within-retention",
    status: "completed",
    expiresAt: shiftedNow(-40),
    completedAt: shiftedNow(-30, 1),
  });
  const accountRedactedCompleted = await insertChallenge({
    label: "account-redacted-completed",
    status: "completed",
    expiresAt: shiftedNow(-40),
    completedAt: shiftedNow(-31),
    resultRedactedAt: shiftedNow(-10),
    accountRedacted: true,
  });

  const expiredIdempotencyId = randomUUID();
  const futureIdempotencyId = randomUUID();
  await harness.database.client`
    INSERT INTO idempotency_records (
      id,
      user_id,
      operation,
      key_hash,
      request_hash,
      expires_at
    )
    VALUES
      (
        ${expiredIdempotencyId},
        ${creatorUserId},
        'cleanup-expired',
        ${fixtureHash("expired-idempotency-key")},
        ${fixtureHash("expired-idempotency-request")},
        ${timestamp(CLEANUP_NOW)}
      ),
      (
        ${futureIdempotencyId},
        ${creatorUserId},
        'cleanup-future',
        ${fixtureHash("future-idempotency-key")},
        ${fixtureHash("future-idempotency-request")},
        ${timestamp(shiftedNow(0, 1))}
      )
  `;

  assert.deepEqual(await runCleanup(harness.database, CLEANUP_NOW), {
    challengesExpired: 1,
    challengesPurged: 2,
    claimedChallengesRedacted: 2,
    claimedChallengesPurged: 2,
    completedChallengesRedacted: 2,
    idempotencyRecordsDeleted: 1,
  });

  assert.equal((await getChallenge(openDue))?.status, "expired");
  assert.equal((await getChallenge(openFuture))?.status, "open");
  assert.equal((await getChallenge(expiredWithinRetention))?.status, "expired");
  assert.equal(await getChallenge(expiredPastRetention), undefined);
  assert.equal(await getChallenge(reportedExpiredPastRetention), undefined);
  const retainedReports = await harness.database.client<
    { id: string; challenge_id: string }[]
  >`
    SELECT id, challenge_id
    FROM reports
    WHERE id IN (${expiredChallengeReportId}, ${claimedChallengeReportId})
  `;
  const retainedReportTargets = new Map(
    retainedReports.map((report) => [report.id, report.challenge_id]),
  );
  assert.equal(
    retainedReportTargets.get(expiredChallengeReportId),
    reportedExpiredPastRetention,
  );
  assert.equal(
    retainedReportTargets.get(claimedChallengeReportId),
    claimedReported,
  );

  assert.equal(await getChallenge(claimedReported), undefined);
  assert.equal(await getChallenge(claimedUnreported), undefined);
  const retainedClaimed = (await getChallenge(claimedWithinRetention))!;
  assert.equal(retainedClaimed.creator_score, 4);
  assert.equal(retainedClaimed.creator_nickname_snapshot, "정리생성자");
  assert.equal(retainedClaimed.opponent_nickname_snapshot, "정리상대방");
  assert.equal(retainedClaimed.result_redacted_at, null);

  assertFullyRedacted((await getChallenge(completedPastRetention))!);
  const retainedCompleted = (await getChallenge(completedWithinRetention))!;
  assert.equal(retainedCompleted.creator_score, 4);
  assert.equal(retainedCompleted.opponent_score, 2);
  assert.equal(retainedCompleted.result_redacted_at, null);
  const retainedAccountRedacted = (await getChallenge(
    accountRedactedCompleted,
  ))!;
  assertSnapshotsRedacted(retainedAccountRedacted);
  assert.equal(
    new Date(retainedAccountRedacted.result_redacted_at!).toISOString(),
    shiftedNow(-10).toISOString(),
  );

  const idempotencyRows = await harness.database.client<
    { id: string; operation: string }[]
  >`
    SELECT id, operation
    FROM idempotency_records
    WHERE id IN (${expiredIdempotencyId}, ${futureIdempotencyId})
  `;
  assert.deepEqual(
    idempotencyRows.map((row) => ({ ...row })),
    [{ id: futureIdempotencyId, operation: "cleanup-future" }],
  );

  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW),
    zeroCounts(),
  );
});

test("cleanup limits each idempotency deletion batch to 500", async () => {
  await harness.database.client`
    INSERT INTO idempotency_records (
      user_id,
      operation,
      key_hash,
      request_hash,
      expires_at
    )
    SELECT
      ${creatorUserId},
      'cleanup-batch',
      md5(series::text) || md5('key-' || series::text),
      md5('request-' || series::text) || md5(series::text),
      ${timestamp(shiftedNow(-1))}
    FROM generate_series(1, ${CLEANUP_BATCH_SIZE + 1}) AS series
  `;

  const first = await runCleanup(harness.database, CLEANUP_NOW);
  assert.deepEqual(first, {
    ...zeroCounts(),
    idempotencyRecordsDeleted: CLEANUP_BATCH_SIZE,
  });

  const remainingAfterFirst = await harness.database.client<
    { count: number }[]
  >`
    SELECT count(*)::int AS count
    FROM idempotency_records
    WHERE operation = 'cleanup-batch'
  `;
  assert.equal(remainingAfterFirst[0]!.count, 1);

  const second = await runCleanup(harness.database, CLEANUP_NOW);
  assert.deepEqual(second, {
    ...zeroCounts(),
    idempotencyRecordsDeleted: 1,
  });
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW),
    zeroCounts(),
  );

  const futureRows = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM idempotency_records
    WHERE operation = 'cleanup-future'
  `;
  assert.equal(futureRows[0]!.count, 1);
});

const operationalOptions = { operationalRetentionEnabled: true };

function operationalCounts(value = 0): CleanupCounts {
  return {
    ...zeroCounts(),
    terminalReportsDeleted: value,
    publishedOutboxDeleted: value,
    adminAuditLogsDeleted: value,
  };
}

async function insertOperationalRows(
  size = 1,
  milliseconds = 0,
  reportStatus = "resolved",
  outboxStatus = "published",
): Promise<{ reports: string[]; outbox: string[]; audits: string[] }> {
  const challengeId = await insertChallenge({
    label: randomUUID(),
    status: "completed",
    expiresAt: shiftedNow(-40),
    completedAt: CLEANUP_NOW,
  });
  const reports = await harness.database.client<{ id: string }[]>`
    INSERT INTO reports (
      reporter_user_id, challenge_id, reason_code, status,
      triaged_by, triaged_at, created_at
    )
    SELECT ${creatorUserId}, ${challengeId}, 'other',
      ${reportStatus}::report_status,
      ${reportStatus === "open" ? null : "cleanup-test"},
      ${reportStatus === "open" ? null : timestamp(shiftedNow(-30, milliseconds))},
      ${timestamp(shiftedNow(-200))}
    FROM generate_series(1, ${size})
    RETURNING id
  `;
  const outbox = await harness.database.client<{ id: string }[]>`
    INSERT INTO notification_outbox (
      event_type, recipient_user_id, challenge_id, dedupe_key,
      status, occurred_at, published_at
    )
    SELECT 'challenge.completed', ${creatorUserId}, ${challengeId},
      gen_random_uuid()::text, ${outboxStatus}::notification_outbox_status,
      ${timestamp(shiftedNow(-200))},
      ${outboxStatus === "published" ? timestamp(shiftedNow(-30, milliseconds)) : null}
    FROM generate_series(1, ${size})
    RETURNING id
  `;
  const audits = await harness.database.client<{ id: string }[]>`
    INSERT INTO admin_audit_logs (
      actor_subject, action, resource_type, resource_id, created_at
    )
    SELECT 'cleanup-test', 'test', 'challenge', ${challengeId},
      ${timestamp(shiftedNow(-180, milliseconds))}
    FROM generate_series(1, ${size})
    RETURNING id
  `;
  return {
    reports: reports.map((row) => row.id).sort(),
    outbox: outbox.map((row) => row.id).sort(),
    audits: audits.map((row) => row.id).sort(),
  };
}

async function retainedOperationalRows(
  fixture: Awaited<ReturnType<typeof insertOperationalRows>>,
) {
  const reports = await harness.database.client<{ id: string }[]>`
    SELECT id FROM reports WHERE id IN ${harness.database.client(fixture.reports)} ORDER BY id
  `;
  const outbox = await harness.database.client<{ id: string }[]>`
    SELECT id FROM notification_outbox WHERE id IN ${harness.database.client(fixture.outbox)} ORDER BY id
  `;
  const audits = await harness.database.client<{ id: string }[]>`
    SELECT id FROM admin_audit_logs WHERE id IN ${harness.database.client(fixture.audits)} ORDER BY id
  `;
  return {
    reports: reports.map((row) => row.id),
    outbox: outbox.map((row) => row.id),
    audits: audits.map((row) => row.id),
  };
}

test("operational retention is opt-in and includes cutoff equality but not +1ms", async () => {
  const before = await insertOperationalRows(1, -1);
  const equal = await insertOperationalRows(1, 0, "dismissed");
  const after = await insertOperationalRows(1, 1);
  const open = await insertOperationalRows(1, 1, "open", "pending");
  const reviewing = await insertOperationalRows(1, 1, "reviewing", "failed");
  const oldReviewing = await insertOperationalRows(1, 1, "open", "failed");
  // Reviewing reports remain live even with an old triage timestamp.
  await harness.database.client`
    UPDATE reports SET status = 'reviewing', triaged_by = 'cleanup-test',
      triaged_at = ${timestamp(shiftedNow(-100))}
    WHERE id = ${oldReviewing.reports[0]!}
  `;
  for (const options of [undefined, { operationalRetentionEnabled: false }]) {
    assert.deepEqual(
      await runCleanup(harness.database, CLEANUP_NOW, options),
      zeroCounts(),
    );
    for (const fixture of [
      before,
      equal,
      after,
      open,
      reviewing,
      oldReviewing,
    ]) {
      assert.deepEqual(await retainedOperationalRows(fixture), fixture);
    }
  }
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(2),
  );
  for (const fixture of [before, equal]) {
    assert.deepEqual(await retainedOperationalRows(fixture), {
      reports: [],
      outbox: [],
      audits: [],
    });
  }
  for (const fixture of [after, open, reviewing, oldReviewing]) {
    assert.deepEqual(await retainedOperationalRows(fixture), fixture);
  }
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(),
  );
});

test("operational retention deterministically limits every stage to 500 and drains to zero", async () => {
  const fixture = await insertOperationalRows(CLEANUP_BATCH_SIZE + 1);
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(500),
  );
  assert.deepEqual(await retainedOperationalRows(fixture), {
    reports: fixture.reports.slice(500),
    outbox: fixture.outbox.slice(500),
    audits: fixture.audits.slice(500),
  });
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(1),
  );
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(),
  );
});

test("operational retention skips locked rows in every stage", async () => {
  const fixture = await insertOperationalRows(2);
  await harness.database.client.begin(async (transaction) => {
    await transaction`SELECT id FROM reports WHERE id = ${fixture.reports[0]!} FOR UPDATE`;
    await transaction`SELECT id FROM notification_outbox WHERE id = ${fixture.outbox[0]!} FOR UPDATE`;
    await transaction`SELECT id FROM admin_audit_logs WHERE id = ${fixture.audits[0]!} FOR UPDATE`;
    assert.deepEqual(
      await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
      operationalCounts(1),
    );
    assert.deepEqual(await retainedOperationalRows(fixture), {
      reports: fixture.reports.slice(0, 1),
      outbox: fixture.outbox.slice(0, 1),
      audits: fixture.audits.slice(0, 1),
    });
  });
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(1),
  );
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(),
  );
});

test("a late operational failure rolls back all cleanup stages", async () => {
  const fixture = await insertOperationalRows();
  const challengeId = await insertChallenge({
    label: randomUUID(),
    status: "open",
    expiresAt: CLEANUP_NOW,
  });
  await harness.database.client`
    CREATE FUNCTION fail_cleanup_audit_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'cleanup rollback sentinel'; END;
    $$
  `;
  await harness.database.client`
    CREATE TRIGGER fail_cleanup_audit_delete BEFORE DELETE ON admin_audit_logs
    FOR EACH ROW EXECUTE FUNCTION fail_cleanup_audit_delete()
  `;
  try {
    await assert.rejects(
      runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
      /cleanup rollback sentinel/,
    );
    assert.deepEqual(await retainedOperationalRows(fixture), fixture);
    assert.equal((await getChallenge(challengeId))?.status, "open");
  } finally {
    await harness.database
      .client`DROP TRIGGER fail_cleanup_audit_delete ON admin_audit_logs`;
    await harness.database.client`DROP FUNCTION fail_cleanup_audit_delete()`;
  }
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    {
      ...operationalCounts(1),
      challengesExpired: 1,
    },
  );
});

test("cleanup rejects invalid clocks regardless of operational opt-in", async () => {
  for (const options of [
    undefined,
    { operationalRetentionEnabled: false },
    operationalOptions,
  ]) {
    await assert.rejects(
      runCleanup(harness.database, new Date(Number.NaN), options),
      {
        name: "TypeError",
        message: "Cleanup time must be a valid Date",
      },
    );
  }
});

test("operational retention leaves attempts, answers, voids, content, and user tombstones untouched", async () => {
  const deletedUserId = await insertUser("deleted");
  const answerUserId = await insertUser("answers");
  const answerAttemptId = randomUUID();
  await harness.database.client`
    INSERT INTO attempts (id, user_id, daily_set_id, status, started_at, updated_at)
    VALUES (${answerAttemptId}, ${answerUserId}, ${dailySetId}, 'started',
      ${timestamp(shiftedNow(-200))}, ${timestamp(shiftedNow(-200))})
  `;
  await harness.database.client`
    UPDATE users SET identity_status = 'deleted',
      deleted_at = ${timestamp(shiftedNow(-200))}
    WHERE id = ${deletedUserId}
  `;
  await harness.database.client`
    INSERT INTO attempt_answers (
      attempt_id, sequence, question_revision_id, selected_index, received_at
    )
    SELECT ${answerAttemptId}, 1, question_revision_id, 0, ${timestamp(shiftedNow(-200, 1))}
    FROM daily_set_items WHERE daily_set_id = ${dailySetId} AND position = 1
  `;
  await harness.database.client`
    UPDATE attempts SET status = 'completed', score = 0,
      completed_at = ${timestamp(shiftedNow(-200, 2))},
      updated_at = ${timestamp(shiftedNow(-200, 2))}
    WHERE id = ${answerAttemptId}
  `;
  await harness.database.client`
    INSERT INTO daily_set_voids (daily_set_id, actor_subject, reason, voided_at)
    VALUES (${dailySetId}, 'cleanup-test', 'retention fixture', ${timestamp(shiftedNow(-200, 3))})
  `;
  const tables = [
    "users",
    "attempts",
    "attempt_answers",
    "daily_set_voids",
    "questions",
    "question_revisions",
    "daily_sets",
    "daily_set_items",
  ];
  const snapshots = await Promise.all(
    tables.map(
      (table) =>
        harness.database.client`
      SELECT to_jsonb(record) AS value
      FROM ${harness.database.client(table)} AS record
      ORDER BY to_jsonb(record)::text
    `,
    ),
  );
  await insertOperationalRows();
  assert.deepEqual(
    await runCleanup(harness.database, CLEANUP_NOW, operationalOptions),
    operationalCounts(1),
  );
  for (const [index, table] of tables.entries()) {
    const rows = await harness.database.client`
      SELECT to_jsonb(record) AS value
      FROM ${harness.database.client(table)} AS record
      ORDER BY to_jsonb(record)::text
    `;
    assert.deepEqual([...rows], [...snapshots[index]!], table);
  }
});

test("worker can run operational cleanup without unrelated DELETE or payload UPDATE privileges", async () => {
  const roleSql = await readFile(
    new URL("../../../../ops/database-runtime-roles.sql", import.meta.url),
    "utf8",
  );
  const roleConnection = await harness.database.client.reserve();
  try {
    await roleConnection.unsafe(roleSql);
  } catch (error) {
    await roleConnection`ROLLBACK`;
    throw error;
  } finally {
    roleConnection.release();
  }
  const fixture = await insertOperationalRows();
  const worker = createDatabase({ ...harness.config, databasePoolMax: 1 });
  try {
    await worker.client`SET ROLE daily_quiz_worker`;
    assert.deepEqual(
      await runCleanup(worker, CLEANUP_NOW, operationalOptions),
      operationalCounts(1),
    );
    assert.deepEqual(await retainedOperationalRows(fixture), {
      reports: [],
      outbox: [],
      audits: [],
    });
    for (const table of [
      "users",
      "attempts",
      "attempt_answers",
      "daily_set_voids",
      "questions",
      "question_revisions",
      "daily_sets",
      "daily_set_items",
    ]) {
      await assert.rejects(
        worker.client`DELETE FROM ${worker.client(table)} WHERE false`,
        { code: "42501" },
      );
    }
    await assert.rejects(
      worker.client`UPDATE reports SET detail = 'forbidden' WHERE false`,
      { code: "42501" },
    );
    await assert.rejects(
      worker.client`UPDATE admin_audit_logs SET metadata = '{}'::jsonb WHERE false`,
      { code: "42501" },
    );
  } finally {
    await worker.close();
  }
});
