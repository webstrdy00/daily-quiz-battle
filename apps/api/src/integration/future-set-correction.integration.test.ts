import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import {
  type AdminCreateQuestionRevisionRequest,
  type Difficulty,
} from "@daily-quiz-battle/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type TransactionSql } from "postgres";
import {
  createDailySetDraft,
  createQuestionRevision,
  listAuditLogs,
  publishDailySet,
  updateQuestionRevisionStatus,
} from "../admin/content-service.js";
import {
  correctFutureDailySet,
  voidDailySet,
  type CorrectFutureDailySetRequest,
} from "../admin/correction-service.js";
import type { Database } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../shared/errors.js";

const actor = "integration-future-correction";
const identityOrder = [0, 1, 2, 3] as const;
const migrationDirectory = new URL("../../migrations/", import.meta.url);
const migrationName = "0018_future_daily_set_correction.sql";
const databaseName = `daily_quiz_it_${randomUUID().replaceAll("-", "")}`;
const runtimeRole = `${databaseName}_runtime`;
let database: Database;
let admin: ReturnType<typeof postgres>;
let now: Date;
let nextOffset = 100;
let startedSet: SetFixture;
let challengedSet: SetFixture;
let userId: string;
let legacyHistory: unknown;
let databaseCreated = false;
let roleCreated = false;

type Item = CorrectFutureDailySetRequest["items"][number];
interface RevisionFixture {
  id: string;
  questionId: string;
  request: AdminCreateQuestionRevisionRequest;
}
interface SetFixture {
  id: string;
  quizDate: string;
  revisions: RevisionFixture[];
  items: Item[];
}

async function createRevision(
  difficulty: Difficulty,
  category: string,
  overrides: Partial<AdminCreateQuestionRevisionRequest> = {},
  publish = true,
): Promise<RevisionFixture> {
  const request: AdminCreateQuestionRevisionRequest = {
    category,
    difficulty,
    prompt: `Synthetic correction fixture ${randomUUID()}`,
    choices: ["Fixture A", "Fixture B", "Fixture C", "Fixture D"],
    correctIndex: 0,
    explanation: "Synthetic fixture explanation, not production content.",
    sourceUrl: "https://example.invalid/future-correction",
    sourceCheckedAt: new Date(now.getTime() - 86_400_000).toISOString(),
    reviewerId: actor,
    timeSensitive: false,
    validUntil: null,
    nextReviewAt: null,
    ...overrides,
  };
  const created = await createQuestionRevision(database, actor, request);
  if (publish) {
    await updateQuestionRevisionStatus(
      database,
      actor,
      created.revisionId,
      "review",
      now,
    );
    await updateQuestionRevisionStatus(
      database,
      actor,
      created.revisionId,
      "approved",
      now,
    );
    await updateQuestionRevisionStatus(
      database,
      actor,
      created.revisionId,
      "published",
      now,
    );
  }
  return { id: created.revisionId, questionId: created.questionId, request };
}

async function validRevisions(): Promise<RevisionFixture[]> {
  return [
    await createRevision("easy", "fixture-a"),
    await createRevision("easy", "fixture-b"),
    await createRevision("medium", "fixture-c"),
    await createRevision("medium", "fixture-d"),
    await createRevision("hard", "fixture-e"),
  ];
}

async function createSet(
  offset = nextOffset++,
  revisions?: RevisionFixture[],
  publish = true,
): Promise<SetFixture> {
  const rows = await database.client<{ quiz_date: string }[]>`
    SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date + ${offset}::int)::text AS quiz_date
  `;
  const quizDate = rows[0]!.quiz_date;
  const selected = revisions ?? (await validRevisions());
  const items = selected.map((revision) => ({
    revisionId: revision.id,
    choiceOrder: [...identityOrder] as [number, number, number, number],
  }));
  const draft = await createDailySetDraft(database, actor, {
    quizDate,
    items: [items[0]!, items[1]!, items[2]!, items[3]!, items[4]!],
  });
  if (publish) await publishDailySet(database, actor, draft.dailySetId, now);
  return { id: draft.dailySetId, quizDate, revisions: selected, items };
}

async function correctionItems(set: SetFixture): Promise<Item[]> {
  const old = set.revisions[0]!;
  const corrected = await createRevision(
    old.request.difficulty,
    old.request.category,
    {
      ...old.request,
      questionId: old.questionId,
      prompt: `${old.request.prompt} corrected`,
      explanation: "Corrected fixture explanation.",
    },
  );
  return [
    { revisionId: corrected.id, choiceOrder: [3, 1, 0, 2] },
    ...set.items.slice(1),
  ];
}

function request(
  items: readonly Item[],
  expectedVersion = 1,
): CorrectFutureDailySetRequest {
  return {
    expectedVersion,
    reason: "Reviewed future editorial correction",
    items,
  };
}

async function snapshot(id: string): Promise<unknown> {
  const rows = await database.client`
    SELECT to_jsonb(ds) AS daily_set,
      (SELECT jsonb_agg(to_jsonb(dsi) ORDER BY position)
        FROM daily_set_items dsi WHERE dsi.daily_set_id = ds.id) AS items,
      (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
        FROM admin_audit_logs a WHERE a.resource_id = ds.id) AS audits
    FROM daily_sets ds WHERE ds.id = ${id}
  `;
  return { ...rows[0] };
}

async function history(): Promise<unknown> {
  const rows = await database.client`
    SELECT
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM attempts a) AS attempts,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM challenges c) AS challenges
  `;
  return { ...rows[0] };
}

async function assertFenceEmpty(): Promise<void> {
  const rows = await database.client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM content_correction_private.authorizations
  `;
  assert.equal(rows[0]!.count, 0);
}

async function rejectsUnchanged(
  set: SetFixture,
  payload: CorrectFutureDailySetRequest,
  code: string,
  injectedNow = now,
): Promise<void> {
  const before = await snapshot(set.id);
  await assert.rejects(
    correctFutureDailySet(database, actor, set.id, payload, injectedNow),
    (error: unknown) => error instanceof AppError && error.code === code,
  );
  assert.deepEqual(await snapshot(set.id), before);
  await assertFenceEmpty();
}

async function asRuntime<T>(
  work: (transaction: TransactionSql<{}>) => Promise<T>,
): Promise<T> {
  return database.client.begin(async (transaction) => {
    await transaction`SET LOCAL ROLE ${transaction(runtimeRole)}`;
    return work(transaction);
  }) as Promise<T>;
}

async function rawCorrection(
  transaction: TransactionSql<{}>,
  set: SetFixture,
  payload: CorrectFutureDailySetRequest,
) {
  return transaction`
    SELECT * FROM public.correct_future_daily_set(
      ${set.id}::uuid, ${payload.expectedVersion}::integer,
      ${actor}::text, ${payload.reason}::text,
      ${JSON.stringify(payload.items)}::jsonb, ${now.toISOString()}::timestamptz
    )
  `;
}

before(async () => {
  const adminUrl =
    process.env.TEST_DATABASE_ADMIN_URL ??
    "postgres://daily_quiz:daily_quiz_local@127.0.0.1:5432/postgres";
  const url = new URL(adminUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  admin = postgres(url.toString(), { max: 1, prepare: false });
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  databaseCreated = true;
  url.pathname = `/${databaseName}`;
  const client = postgres(url.toString(), { max: 5, prepare: false });
  database = {
    client,
    orm: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
  // Legacy future assignments are fixtures from BEFORE the new DB date gate.
  // Never disable triggers or mutate published dates to manufacture them.
  for (const name of (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (name >= migrationName) break;
    const sql = await readFile(new URL(name, migrationDirectory), "utf8");
    await client.begin((transaction) => transaction.unsafe(sql));
  }
  const clock = await client<
    { current_time: Date | string }[]
  >`SELECT clock_timestamp() AS current_time`;
  now = new Date(clock[0]!.current_time);
  const users = await client<{ id: string }[]>`
    INSERT INTO users (anon_key_fingerprint, identity_verified_at)
    VALUES (${randomUUID()}, ${now.toISOString()}) RETURNING id
  `;
  userId = users[0]!.id;
  startedSet = await createSet(2);
  await client`INSERT INTO attempts (user_id, daily_set_id) VALUES (${userId}, ${startedSet.id})`;
  challengedSet = await createSet(3);
  await client`
    INSERT INTO challenges (public_token_hash, daily_set_id, status, expires_at)
    VALUES (${randomUUID().replaceAll("-", "")}, ${challengedSet.id}, 'expired', clock_timestamp() + interval '1 day')
  `;
  legacyHistory = await history();
  const sql = await readFile(
    new URL(migrationName, migrationDirectory),
    "utf8",
  );
  await client.begin((transaction) => transaction.unsafe(sql));

  // An isolated NOLOGIN role models the API's public-table CRUD privileges;
  // only the narrow correction capability is granted, never the private fence.
  await admin`CREATE ROLE ${admin(runtimeRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
  roleCreated = true;
  await client`GRANT USAGE ON SCHEMA public TO ${client(runtimeRole)}`;
  await client`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${client(runtimeRole)}`;
  await client`GRANT EXECUTE ON FUNCTION public.correct_future_daily_set(uuid, integer, text, text, jsonb, timestamptz) TO ${client(runtimeRole)}`;
});

after(async () => {
  try {
    await database?.close();
    if (databaseCreated)
      await admin`DROP DATABASE ${admin(databaseName)} WITH (FORCE)`;
    if (roleCreated) await admin`DROP ROLE ${admin(runtimeRole)}`;
  } finally {
    await admin?.end({ timeout: 5 });
  }
});

test("future correction keeps the same published set and immutable revisions, increments once, audits exact snapshots", async () => {
  const set = await createSet();
  const items = await correctionItems(set);
  const oldIds = set.revisions.map((revision) => revision.id);
  const oldRevisions =
    await database.client`SELECT to_jsonb(qr) AS revision FROM question_revisions qr WHERE id IN ${database.client(oldIds)} ORDER BY id`;
  const before = (await snapshot(set.id)) as {
    daily_set: Record<string, unknown>;
  };
  const result = await correctFutureDailySet(
    database,
    actor,
    set.id,
    request(items),
    now,
  );
  assert.deepEqual(result, { id: set.id, version: 2 });
  const sets =
    await database.client`SELECT to_jsonb(ds) AS daily_set FROM daily_sets ds WHERE id = ${set.id}`;
  assert.deepEqual(sets[0]!.daily_set, { ...before.daily_set, version: 2 });
  const currentItems = await database.client`
    SELECT position::int, question_revision_id AS revision_id, choice_order
    FROM daily_set_items WHERE daily_set_id = ${set.id} ORDER BY position
  `;
  assert.deepEqual(
    currentItems.map((item) => ({
      revisionId: item.revision_id,
      choiceOrder: item.choice_order,
    })),
    items,
  );
  assert.deepEqual(
    currentItems.map((item) => item.position),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    await database.client`SELECT to_jsonb(qr) AS revision FROM question_revisions qr WHERE id IN ${database.client(oldIds)} ORDER BY id`,
    oldRevisions,
  );
  const audit = await database.client`
    SELECT actor_subject, metadata, created_at FROM admin_audit_logs
    WHERE resource_id = ${set.id} AND action = 'daily_set.correct'
  `;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actor_subject, actor);
  assert.equal(new Date(audit[0]!.created_at).toISOString(), now.toISOString());
  assert.deepEqual(audit[0]!.metadata, {
    action: "daily_set.correct",
    reason: request(items).reason,
    oldVersion: 1,
    newVersion: 2,
    oldItems: set.items,
    newItems: items,
  });
  const logs = await listAuditLogs(database, { limit: 100 });
  const listed = logs.auditLogs.find(
    (entry) =>
      entry.resourceId === set.id && entry.action === "daily_set.correct",
  );
  assert.deepEqual(listed?.metadata, audit[0]!.metadata);
  assert.deepEqual(await history(), legacyHistory);
  await assertFenceEmpty();
  await rejectsUnchanged(set, request(items), "DAILY_SET_VERSION_CONFLICT");
  await rejectsUnchanged(
    set,
    request(items, 2),
    "DAILY_SET_CORRECTION_NO_CHANGE",
  );
  const swapped = [items[1]!, items[0]!, ...items.slice(2)];
  assert.deepEqual(
    await correctFutureDailySet(
      database,
      actor,
      set.id,
      request(swapped, 2),
      now,
    ),
    {
      id: set.id,
      version: 3,
    },
  );
  await assertFenceEmpty();
});

test("past, current, nonpublished, void, legacy started and challenged sets cannot be corrected", async () => {
  for (const offset of [-1, 0]) {
    const set = await createSet(offset);
    await rejectsUnchanged(
      set,
      request(await correctionItems(set)),
      "DAILY_SET_NOT_FUTURE",
      new Date("2000-01-01T00:00:00Z"),
    );
  }
  for (const [set, code] of [
    [startedSet, "DAILY_SET_ALREADY_PLAYED"],
    [challengedSet, "DAILY_SET_ALREADY_CHALLENGED"],
  ] as const) {
    await rejectsUnchanged(set, request(await correctionItems(set)), code);
  }
  const draft = await createSet(undefined, undefined, false);
  await rejectsUnchanged(
    draft,
    request(await correctionItems(draft)),
    "DAILY_SET_NOT_PUBLISHED",
  );
  const retired = await createSet();
  await database.client`UPDATE daily_sets SET status = 'retired' WHERE id = ${retired.id}`;
  await rejectsUnchanged(
    retired,
    request(await correctionItems(retired)),
    "DAILY_SET_NOT_PUBLISHED",
  );
  const voided = await createSet();
  await voidDailySet(
    database,
    actor,
    voided.id,
    { reason: "Fixture void" },
    now,
  );
  await rejectsUnchanged(
    voided,
    request(await correctionItems(voided)),
    "DAILY_SET_ALREADY_VOIDED",
  );
  await assert.rejects(
    correctFutureDailySet(
      database,
      actor,
      randomUUID(),
      request(await correctionItems(voided)),
      now,
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "DAILY_SET_NOT_FOUND",
  );
  assert.deepEqual(await history(), legacyHistory);
});

test("invalid payload, unpublished, missing, repeated revisions and logical questions roll back unchanged", async () => {
  const set = await createSet();
  const valid = await correctionItems(set);
  const invalidRequests = [
    { ...request(valid), expectedVersion: 0 },
    { ...request(valid), reason: " " },
    request(valid.slice(0, 4)),
    request([{ ...valid[0]!, choiceOrder: [0, 0, 2, 3] }, ...valid.slice(1)]),
    request([{ ...valid[0]!, choiceOrder: [0, 1, 2, 4] }, ...valid.slice(1)]),
    { ...request(valid), unexpected: true },
  ];
  for (const invalid of invalidRequests)
    await rejectsUnchanged(set, invalid, "INVALID_REQUEST");
  await rejectsUnchanged(set, request(valid, 9), "DAILY_SET_VERSION_CONFLICT");
  await rejectsUnchanged(
    set,
    request([
      { revisionId: randomUUID(), choiceOrder: identityOrder },
      ...valid.slice(1),
    ]),
    "DAILY_SET_REVISION_INTEGRITY_ERROR",
  );
  await rejectsUnchanged(
    set,
    request([valid[1]!, ...valid.slice(1)]),
    "DAILY_SET_REVISIONS_NOT_DISTINCT",
  );
  const unpublished = await createRevision("easy", "fixture-a", {}, false);
  await rejectsUnchanged(
    set,
    request([
      { revisionId: unpublished.id, choiceOrder: identityOrder },
      ...valid.slice(1),
    ]),
    "DAILY_SET_REVISION_NOT_PUBLISHED",
  );
  const retired = await createRevision("easy", "fixture-a");
  await updateQuestionRevisionStatus(
    database,
    actor,
    retired.id,
    "retired",
    now,
  );
  await rejectsUnchanged(
    set,
    request([
      { revisionId: retired.id, choiceOrder: identityOrder },
      ...valid.slice(1),
    ]),
    "DAILY_SET_REVISION_NOT_PUBLISHED",
  );
  const sameQuestion = await createRevision("easy", "fixture-a", {
    questionId: set.revisions[1]!.questionId,
  });
  await rejectsUnchanged(
    set,
    request([
      { revisionId: sameQuestion.id, choiceOrder: identityOrder },
      ...valid.slice(1),
    ]),
    "DAILY_SET_LOGICAL_QUESTIONS_NOT_DISTINCT",
  );
  // Direct SQL invocation receives the same structural validation, not just Zod.
  const baseline = await snapshot(set.id);
  await assert.rejects(
    database.client.begin((transaction) =>
      rawCorrection(
        transaction,
        set,
        request([
          { ...valid[0]!, choiceOrder: [0, 0, 2, 3] },
          ...valid.slice(1),
        ]),
      ),
    ),
    /INVALID_REQUEST/,
  );
  assert.deepEqual(await snapshot(set.id), baseline);
  await assertFenceEmpty();
});

test("difficulty, category, deadline and inclusive +/-14-day repetition match publication rules", async () => {
  const set = await createSet();
  const valid = await correctionItems(set);
  const medium = await createRevision("medium", "fixture-a");
  await rejectsUnchanged(
    set,
    request([
      { revisionId: medium.id, choiceOrder: identityOrder },
      ...valid.slice(1),
    ]),
    "DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID",
  );
  const easy = await createRevision("easy", "fixture-e");
  await rejectsUnchanged(
    set,
    request([
      ...valid.slice(0, 4),
      { revisionId: easy.id, choiceOrder: identityOrder },
    ]),
    "DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID",
  );
  const hard = await createRevision("hard", "fixture-c");
  await rejectsUnchanged(
    set,
    request([
      valid[0]!,
      valid[1]!,
      { revisionId: hard.id, choiceOrder: identityOrder },
      valid[3]!,
      valid[4]!,
    ]),
    "DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID",
  );
  const categoryEasy = await createRevision("easy", "fixture-a");
  const categoryMedium = await createRevision("medium", "fixture-a");
  await rejectsUnchanged(
    set,
    request([
      valid[0]!,
      { revisionId: categoryEasy.id, choiceOrder: identityOrder },
      { revisionId: categoryMedium.id, choiceOrder: identityOrder },
      valid[3]!,
      valid[4]!,
    ]),
    "DAILY_SET_CATEGORY_LIMIT_EXCEEDED",
  );
  const deadline = new Date(`${set.quizDate}T16:00:00.000Z`);
  for (const delta of [-1, 0]) {
    const expired = await createRevision("easy", "fixture-a", {
      timeSensitive: true,
      validUntil: new Date(deadline.getTime() + delta).toISOString(),
      nextReviewAt: now.toISOString(),
    });
    await rejectsUnchanged(
      set,
      request([
        { revisionId: expired.id, choiceOrder: identityOrder },
        ...valid.slice(1),
      ]),
      "DAILY_SET_REVISION_VALIDITY_EXPIRED",
    );
  }
  const targetOffset = nextOffset++;
  const repeated = await createSet(targetOffset);
  const replacement = await createRevision("easy", "fixture-a");
  const neighborRevisions = await validRevisions();
  neighborRevisions[0] = replacement;
  await createSet(targetOffset + 14, neighborRevisions);
  await rejectsUnchanged(
    repeated,
    request([
      { revisionId: replacement.id, choiceOrder: identityOrder },
      ...repeated.items.slice(1),
    ]),
    "DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED",
  );
  const earlierTargetOffset = nextOffset++;
  const earlierTarget = await createSet(earlierTargetOffset);
  const earlierReplacement = await createRevision("easy", "fixture-a");
  const earlierNeighbors = await validRevisions();
  earlierNeighbors[0] = earlierReplacement;
  await createSet(earlierTargetOffset - 14, earlierNeighbors);
  await rejectsUnchanged(
    earlierTarget,
    request([
      { revisionId: earlierReplacement.id, choiceOrder: identityOrder },
      ...earlierTarget.items.slice(1),
    ]),
    "DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED",
  );
  // The deadline is strict but no additional next_review_at date policy exists.
  const fresh = await createRevision("easy", "fixture-a", {
    timeSensitive: true,
    validUntil: new Date(deadline.getTime() + 1).toISOString(),
    nextReviewAt: now.toISOString(),
  });
  assert.deepEqual(
    await correctFutureDailySet(
      database,
      actor,
      set.id,
      request([
        { revisionId: fresh.id, choiceOrder: identityOrder },
        ...set.items.slice(1),
      ]),
      now,
    ),
    { id: set.id, version: 2 },
  );
  const outsideOffset = nextOffset++;
  const outsideTarget = await createSet(outsideOffset);
  const outsideReplacement = await createRevision("easy", "fixture-a");
  const outsideNeighbors = await validRevisions();
  outsideNeighbors[0] = outsideReplacement;
  await createSet(outsideOffset + 15, outsideNeighbors);
  assert.deepEqual(
    await correctFutureDailySet(
      database,
      actor,
      outsideTarget.id,
      request([
        { revisionId: outsideReplacement.id, choiceOrder: identityOrder },
        ...outsideTarget.items.slice(1),
      ]),
      now,
    ),
    { id: outsideTarget.id, version: 2 },
  );
  await assertFenceEmpty();
});

test("publication and correction both accept two easy and three medium without mandatory hard content", async () => {
  const allMediumRemainder = await validRevisions();
  allMediumRemainder[4] = await createRevision("medium", "fixture-e");
  const publishedWithoutHard = await createSet(undefined, allMediumRemainder);
  const publishedCounts = await database.client`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE qr.difficulty = 'easy')::int AS easy,
      count(*) FILTER (WHERE qr.difficulty = 'medium')::int AS medium,
      count(*) FILTER (WHERE qr.difficulty = 'hard')::int AS hard
    FROM daily_set_items dsi JOIN question_revisions qr ON qr.id = dsi.question_revision_id
    WHERE dsi.daily_set_id = ${publishedWithoutHard.id}
  `;
  assert.deepEqual(
    { ...publishedCounts[0] },
    { total: 5, easy: 2, medium: 3, hard: 0 },
  );

  const set = await createSet();
  const originalHard = set.revisions[4]!;
  const relabeledMedium = await createRevision(
    "medium",
    originalHard.request.category,
    {
      ...originalHard.request,
      questionId: originalHard.questionId,
      difficulty: "medium",
      explanation: "Reviewed honest medium difficulty correction.",
    },
  );
  const oldRevision =
    await database.client`SELECT to_jsonb(qr) AS revision FROM question_revisions qr WHERE id = ${originalHard.id}`;
  const items = [
    ...set.items.slice(0, 4),
    { revisionId: relabeledMedium.id, choiceOrder: identityOrder },
  ];
  assert.deepEqual(
    await correctFutureDailySet(database, actor, set.id, request(items), now),
    {
      id: set.id,
      version: 2,
    },
  );
  const correctedCounts = await database.client`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE qr.difficulty = 'easy')::int AS easy,
      count(*) FILTER (WHERE qr.difficulty = 'medium')::int AS medium,
      count(*) FILTER (WHERE qr.difficulty = 'hard')::int AS hard
    FROM daily_set_items dsi JOIN question_revisions qr ON qr.id = dsi.question_revision_id
    WHERE dsi.daily_set_id = ${set.id}
  `;
  assert.deepEqual(
    { ...correctedCounts[0] },
    { total: 5, easy: 2, medium: 3, hard: 0 },
  );
  assert.deepEqual(
    await database.client`SELECT to_jsonb(qr) AS revision FROM question_revisions qr WHERE id = ${originalHard.id}`,
    oldRevision,
  );
  await assertFenceEmpty();
});

test("audit failure and caller rollback restore items, version, audit and authorization", async () => {
  const set = await createSet();
  const items = await correctionItems(set);
  const baseline = await snapshot(set.id);
  await database.client`
    CREATE FUNCTION reject_future_correction_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'daily_set.correct' THEN RAISE EXCEPTION 'injected correction audit failure'; END IF;
      RETURN NEW;
    END;
    $$
  `;
  await database.client`CREATE TRIGGER reject_future_correction_audit_trg BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION reject_future_correction_audit()`;
  try {
    await assert.rejects(
      correctFutureDailySet(database, actor, set.id, request(items), now),
      /injected correction audit failure/,
    );
    assert.deepEqual(await snapshot(set.id), baseline);
    await assertFenceEmpty();
  } finally {
    await database.client`DROP TRIGGER reject_future_correction_audit_trg ON admin_audit_logs`;
    await database.client`DROP FUNCTION reject_future_correction_audit()`;
  }
  await assert.rejects(
    database.client.begin(async (transaction) => {
      await rawCorrection(transaction, set, request(items));
      const rows =
        await transaction`SELECT count(*)::int AS count FROM content_correction_private.authorizations`;
      assert.equal(
        rows[0]!.count,
        0,
        "successful function removes authorization before returning",
      );
      await assert.rejects(
        transaction`UPDATE daily_set_items SET choice_order = '[1,0,2,3]'::jsonb WHERE daily_set_id = ${set.id} AND position = 1`,
        /immutable/,
      );
      throw new Error("injected caller rollback");
    }),
    /injected caller rollback/,
  );
  assert.deepEqual(await snapshot(set.id), baseline);
  await assertFenceEmpty();
  assert.deepEqual(
    await correctFutureDailySet(database, actor, set.id, request(items), now),
    { id: set.id, version: 2 },
  );
});

test("raw published mutation and forged authorization remain denied, narrow runtime correction succeeds", async () => {
  const set = await createSet();
  const items = await correctionItems(set);
  const baseline = await snapshot(set.id);
  await assert.rejects(
    asRuntime(async (transaction) => {
      await transaction`SELECT set_config('app.daily_set_correction', ${set.id}, true)`;
      await transaction`UPDATE daily_set_items SET choice_order = '[3,2,1,0]'::jsonb WHERE daily_set_id = ${set.id} AND position = 1`;
    }),
    /immutable/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`DELETE FROM daily_set_items WHERE daily_set_id = ${set.id}`,
    ),
    /immutable/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) => transaction`
    INSERT INTO daily_set_items (daily_set_id, position, question_revision_id, choice_order)
    VALUES (${set.id}, 1, ${items[0]!.revisionId}, '[0,1,2,3]'::jsonb)
  `,
    ),
    /immutable/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`UPDATE daily_sets SET version = version + 1 WHERE id = ${set.id}`,
    ),
    /immutable/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`UPDATE daily_sets SET quiz_date = quiz_date + 1000 WHERE id = ${set.id}`,
    ),
    /immutable/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`UPDATE question_revisions SET explanation = 'forged correction' WHERE id = ${set.revisions[0]!.id}`,
    ),
    /immutable/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`INSERT INTO content_correction_private.authorizations VALUES (pg_current_xact_id(), ${set.id}, 1, '[]', '[]')`,
    ),
    /permission denied/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`SELECT content_correction_private.assert_future_unplayed(${set.id})`,
    ),
    /permission denied/,
  );
  const permissions = await database.client`
    SELECT acl.grantee FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.correct_future_daily_set(uuid,integer,text,text,jsonb,timestamptz)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  `;
  assert.equal(
    permissions.length,
    0,
    "PUBLIC has no correction execution capability",
  );
  assert.deepEqual(await snapshot(set.id), baseline);
  const rows = await asRuntime((transaction) =>
    rawCorrection(transaction, set, request(items)),
  );
  assert.deepEqual({ ...rows[0] }, { id: set.id, version: 2 });
  await assertFenceEmpty();
});

test("DB forbids future attempt/challenge assignment but preserves current and historical starts", async () => {
  const future = await createSet();
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`INSERT INTO attempts (user_id, daily_set_id) VALUES (${userId}, ${future.id})`,
    ),
    /future daily sets cannot be assigned/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) => transaction`
    INSERT INTO challenges (public_token_hash, daily_set_id, status, expires_at)
    VALUES (${randomUUID()}, ${future.id}, 'expired', clock_timestamp() + interval '1 day')
  `,
    ),
    /future daily sets cannot be assigned/,
  );
  await assert.rejects(
    asRuntime(
      (transaction) =>
        transaction`UPDATE attempts SET daily_set_id = ${future.id} WHERE daily_set_id = ${startedSet.id}`,
    ),
    /future daily sets cannot be assigned/,
  );
  const past = await createSet(-2);
  const rows = await asRuntime(
    (transaction) =>
      transaction`INSERT INTO attempts (user_id, daily_set_id) VALUES (${userId}, ${past.id}) RETURNING id`,
  );
  assert.equal(rows.length, 1);
  const current = await database.client<{ id: string }[]>`
    SELECT id FROM daily_sets WHERE quiz_date = (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date
  `;
  const currentSetId = current[0]?.id ?? (await createSet(0)).id;
  const currentRows = await asRuntime(
    (transaction) =>
      transaction`INSERT INTO attempts (user_id, daily_set_id) VALUES (${userId}, ${currentSetId}) RETURNING id`,
  );
  assert.equal(currentRows.length, 1);
});

test("concurrent correction CAS and correction/publication share the publication lock", async () => {
  const set = await createSet();
  const items = await correctionItems(set);
  const results = await Promise.allSettled([
    correctFutureDailySet(database, actor, set.id, request(items), now),
    correctFutureDailySet(database, actor, set.id, request(items), now),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" && rejected.reason instanceof AppError,
  );
  assert.equal(rejected.reason.code, "DAILY_SET_VERSION_CONFLICT");
  const offset = nextOffset++;
  const target = await createSet(offset);
  const replacement = await createRevision("easy", "fixture-a");
  const draftRevisions = await validRevisions();
  draftRevisions[0] = replacement;
  const draft = await createSet(offset + 1, draftRevisions, false);
  nextOffset = offset + 2;
  const competing = await Promise.allSettled([
    correctFutureDailySet(
      database,
      actor,
      target.id,
      request([
        { revisionId: replacement.id, choiceOrder: identityOrder },
        ...target.items.slice(1),
      ]),
      now,
    ),
    publishDailySet(database, actor, draft.id, now),
  ]);
  assert.equal(
    competing.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const conflict = competing.find((result) => result.status === "rejected");
  assert.ok(
    conflict?.status === "rejected" && conflict.reason instanceof AppError,
  );
  assert.equal(
    conflict.reason.code,
    "DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED",
  );
  await assertFenceEmpty();
});
