import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  AdminCreateDailySetDraftRequestSchema,
  type AdminCreateQuestionRevisionRequest,
} from "@daily-quiz-battle/contracts";
import {
  applyContentCorrections,
  previewContentCorrections,
} from "../../../../ops/apply-content-corrections.mjs";
import {
  createDailySetDraft,
  createQuestionRevision,
  publishDailySet,
  updateQuestionRevisionStatus,
} from "../admin/content-service.js";
import { correctFutureDailySet } from "../admin/correction-service.js";
import type { Database } from "../db/client.js";
import { createIntegrationHarness } from "./test-harness.js";

const ACTOR = "integration-editorial-corrections";
const NOW = new Date("2099-12-01T03:00:00.000Z");
const OPTIONS = { expectedCount: 5, now: NOW };
interface BaselineRow {
  id: string;
  question_id: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  prompt: string;
  choices: [string, string, string, string];
  correct_index: 0 | 1 | 2 | 3;
  explanation: string;
  source_url: string;
  source_checked_at: string;
  reviewer_id: string;
  lifecycle_status: string;
  time_sensitive?: boolean;
  valid_until: string | null;
  next_review_at: string | null;
}
async function baseline(
  database: Database,
): Promise<{ questions: BaselineRow[] }> {
  const rows = await database.client<{ row: BaselineRow }[]>`
    SELECT jsonb_build_object('id', id, 'question_id', question_id, 'category', category,
      'difficulty', difficulty, 'prompt', prompt, 'choices', choices, 'correct_index', correct_index,
      'explanation', explanation, 'source_url', source_url, 'source_checked_at', source_checked_at,
      'reviewer_id', reviewer_id, 'lifecycle_status', lifecycle_status, 'time_sensitive', time_sensitive,
      'valid_until', valid_until, 'next_review_at', next_review_at) AS row
    FROM question_revisions ORDER BY id
  `;
  return { questions: rows.map((row) => row.row) };
}
function reviewed(snapshot: { questions: BaselineRow[] }) {
  return {
    items: snapshot.questions.map((row, index) => {
      const payload: AdminCreateQuestionRevisionRequest = {
        questionId: row.question_id,
        category: row.category,
        difficulty: row.difficulty,
        prompt: row.prompt,
        choices: row.choices,
        correctIndex: row.correct_index,
        explanation: row.explanation,
        sourceUrl: row.source_url,
        sourceCheckedAt: "2026-08-28T00:00:00.000Z",
        reviewerId: "integration-editorial-review",
        timeSensitive: row.time_sensitive!,
        validUntil: row.valid_until,
        nextReviewAt: row.next_review_at,
      };
      if (index === 0)
        payload.explanation += " Integration-only editorial clarification.";
      return {
        revisionId: row.id,
        questionId: row.question_id,
        decision:
          index === 0
            ? ("revise" as "keep" | "revise" | "blocked")
            : ("keep" as "keep" | "revise" | "blocked"),
        issues: index === 0 ? ["Synthetic editorial ambiguity"] : [],
        changes:
          index === 0
            ? ["Clarify explanation without changing difficulty"]
            : [],
        sourceChecks: [
          {
            url: row.source_url,
            result: "verified" as "verified" | "unavailable",
            evidence:
              "Synthetic integration fixture, not a real source verification claim.",
            checkedAt: "2026-08-28T00:00:00.000Z",
          },
        ],
        payload,
      };
    }),
  };
}
async function counts(database: Database) {
  const rows = await database.client`
    SELECT (SELECT count(*)::int FROM questions) AS questions,
      (SELECT count(*)::int FROM question_revisions) AS revisions,
      (SELECT count(*)::int FROM admin_audit_logs) AS audits,
      (SELECT count(*)::int FROM daily_sets) AS sets
  `;
  return { ...rows[0] };
}
async function setSnapshot(database: Database, id?: string) {
  return database.client`
    SELECT ds.id, ds.quiz_date::text, ds.version, ds.status::text, ds.published_at,
      dsi.position, dsi.question_revision_id, dsi.choice_order, qr.question_id
    FROM daily_sets ds JOIN daily_set_items dsi ON dsi.daily_set_id = ds.id
    JOIN question_revisions qr ON qr.id = dsi.question_revision_id
    WHERE (${id ?? null}::uuid IS NULL OR ds.id = ${id ?? null}::uuid)
    ORDER BY ds.quiz_date, dsi.position
  `;
}
async function futureSet(
  database: Database,
  snapshot: { questions: BaselineRow[] },
) {
  const created = await createDailySetDraft(
    database,
    ACTOR,
    AdminCreateDailySetDraftRequestSchema.parse({
      quizDate: "2100-01-10",
      items: snapshot.questions.map((row) => ({
        revisionId: row.id,
        choiceOrder: [2, 0, 3, 1],
      })),
    }),
  );
  await publishDailySet(database, ACTOR, created.dailySetId, NOW);
  return created.dailySetId;
}

test("content corrections validate before mutation, preview read-only, preserve history, and resume per-set failure", async (context) => {
  const harness = await createIntegrationHarness();
  try {
    const { database } = harness;
    const source = await baseline(database);
    const input = reviewed(source);
    const futureId = await futureSet(database, source);
    const originalSets = await setSnapshot(database);
    const sourceBefore = await baseline(database);
    const before = await counts(database);
    await context.test(
      "invalid payloads, unknown references and incomplete inventories fail before even opening a transaction",
      async () => {
        const forbiddenDatabase: Database = {
          ...database,
          client: new Proxy(database.client, {
            get(target, property, receiver) {
              if (property === "begin")
                return () => {
                  assert.fail("Invalid input reached the database");
                };
              return Reflect.get(target, property, receiver);
            },
          }),
        };
        const invalid = structuredClone(input);
        (invalid.items[3]!.payload as { correctIndex: number }).correctIndex =
          99;
        await assert.rejects(
          applyContentCorrections(
            forbiddenDatabase,
            invalid,
            source,
            ACTOR,
            OPTIONS,
          ),
          /INVALID_PAYLOAD/,
        );
        const unknown = structuredClone(input);
        unknown.items[3]!.revisionId = randomUUID();
        await assert.rejects(
          applyContentCorrections(
            forbiddenDatabase,
            unknown,
            source,
            ACTOR,
            OPTIONS,
          ),
          /UNKNOWN_SOURCE_REFERENCE/,
        );
        const wrongQuestion = structuredClone(input);
        wrongQuestion.items[0]!.payload.questionId = randomUUID();
        await assert.rejects(
          applyContentCorrections(
            forbiddenDatabase,
            wrongQuestion,
            source,
            ACTOR,
            OPTIONS,
          ),
          /QUESTION_IDENTITY_MISMATCH/,
        );
        const duplicate = structuredClone(input);
        duplicate.items[4] = duplicate.items[0]!;
        await assert.rejects(
          applyContentCorrections(
            forbiddenDatabase,
            duplicate,
            source,
            ACTOR,
            OPTIONS,
          ),
          /INVALID_OR_DUPLICATE_SOURCE_ID/,
        );
        await assert.rejects(
          applyContentCorrections(
            forbiddenDatabase,
            { items: input.items.slice(1) },
            source,
            ACTOR,
            OPTIONS,
          ),
          /INCOMPLETE_AUDIT_BASELINE/,
        );
        await assert.rejects(
          applyContentCorrections(forbiddenDatabase, input, source, ACTOR),
          /INCOMPLETE_AUDIT_BASELINE/,
        );
        assert.deepEqual(await counts(database), before);
      },
    );
    await context.test(
      "source drift rejects the whole batch before any correction is created",
      async () => {
        const changed = structuredClone(source);
        changed.questions[2]!.explanation += " Not the captured original.";
        await assert.rejects(
          applyContentCorrections(database, input, changed, ACTOR, OPTIONS),
          /SOURCE_DRIFT/,
        );
        const statusDrift = structuredClone(source);
        statusDrift.questions[2]!.lifecycle_status = "draft";
        await assert.rejects(
          applyContentCorrections(database, input, statusDrift, ACTOR, OPTIONS),
          /SOURCE_DRIFT/,
        );
        assert.deepEqual(await counts(database), before);
      },
    );
    await context.test(
      "preview plans replacements but writes no rows, revisions, lifecycle statuses or audit logs",
      async () => {
        const result = await previewContentCorrections(
          database,
          input,
          source,
          ACTOR,
          OPTIONS,
        );
        assert.equal(result.mode, "preview");
        assert.equal(result.created, 0);
        assert.equal(result.items[0]?.correctedRevisionId, null);
        assert.equal(
          result.sets.find((set) => set.dailySetId === futureId)?.status,
          "planned",
        );
        assert.equal(
          result.sets.filter((set) => set.status === "historical_set_unchanged")
            .length,
          2,
        );
        assert.equal(
          result.items.find((item) => item.decision === "revise")
            ?.historicalSetUnchanged,
          true,
        );
        assert.deepEqual(await counts(database), before);
        assert.deepEqual(await setSnapshot(database), originalSets);
        assert.deepEqual(await baseline(database), sourceBefore);
      },
    );
    await context.test(
      "missing time_sensitive is verified against DB false and null temporal metadata before apply",
      async () => {
        const missing = structuredClone(source);
        for (const row of missing.questions) delete row.time_sensitive;
        const result = await previewContentCorrections(
          database,
          input,
          missing,
          ACTOR,
          OPTIONS,
        );
        assert.equal(result.warnings.length, 5);
        assert.ok(
          result.warnings.every((warning) =>
            warning.startsWith("BASELINE_TIME_SENSITIVE_DB_FALSE_VERIFIED:"),
          ),
        );
        assert.equal(
          result.sets.find((set) => set.dailySetId === futureId)?.status,
          "planned",
        );
        const unchanged = structuredClone(input);
        for (const item of unchanged.items) item.decision = "keep";
        const applied = await applyContentCorrections(
          database,
          unchanged,
          missing,
          ACTOR,
          OPTIONS,
        );
        assert.equal(applied.status, "applied");
        assert.equal(applied.created, 0);
        assert.deepEqual(await counts(database), before);
      },
    );
    await context.test(
      "difficulty/category violations are visible in preview without silent relabeling",
      async () => {
        const invalid = structuredClone(input);
        invalid.items[0]!.payload.difficulty = "hard";
        for (const item of invalid.items.slice(0, 3)) {
          item.decision = "revise";
          item.payload.category = "integration-category";
        }
        const result = await previewContentCorrections(
          database,
          invalid,
          source,
          ACTOR,
          OPTIONS,
        );
        const future = result.sets.find((set) => set.dailySetId === futureId)!;
        assert.equal(future.status, "blocked");
        assert.ok(
          future.blockedReasons.includes(
            "DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID",
          ),
        );
        assert.ok(
          future.blockedReasons.includes("DAILY_SET_CATEGORY_LIMIT_EXCEEDED"),
        );
        assert.deepEqual(await counts(database), before);
      },
    );
    await context.test(
      "per-set failure leaves editorial revision committed, set untouched, and secret error text sanitized",
      async () => {
        await database.client`
        CREATE FUNCTION reject_editorial_set_change() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.version <> OLD.version THEN
            RAISE EXCEPTION 'postgres://private-user:private-password@private-host/private-db';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
        await database.client`CREATE TRIGGER reject_editorial_set_change BEFORE UPDATE ON daily_sets FOR EACH ROW EXECUTE FUNCTION reject_editorial_set_change()`;
        try {
          const partial = await applyContentCorrections(
            database,
            input,
            source,
            ACTOR,
            OPTIONS,
          );
          assert.equal(partial.status, "partial");
          assert.equal(partial.created, 1);
          const future = partial.sets.find(
            (set) => set.dailySetId === futureId,
          )!;
          assert.equal(future.status, "blocked");
          assert.deepEqual(future.blockedReasons, [
            "CONTENT_CORRECTIONS_FAILED",
          ]);
          assert.ok(!JSON.stringify(partial).includes("private-password"));
          assert.deepEqual(await setSnapshot(database), originalSets);
          const after = await counts(database);
          assert.equal(after.questions, before.questions);
          assert.equal(after.revisions, before.revisions + 1);
          // create + own mapping + review/approved/published; no set audit escaped rollback.
          assert.equal(after.audits, before.audits + 5);
        } finally {
          await database.client`DROP TRIGGER reject_editorial_set_change ON daily_sets`;
          await database.client`DROP FUNCTION reject_editorial_set_change()`;
        }
      },
    );
    const result = await applyContentCorrections(
      database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    await context.test(
      "resume uses the same correction and switches only the future set atomically",
      async () => {
        assert.equal(result.status, "applied");
        assert.equal(result.created, 0);
        assert.equal(result.existing, 1);
        const corrected = result.items.find(
          (item) => item.decision === "revise",
        )!;
        assert.ok(corrected.correctedRevisionId);
        const future = result.sets.find((set) => set.dailySetId === futureId)!;
        assert.equal(future.status, "corrected");
        assert.equal(future.expectedVersion, 1);
        assert.equal(future.resultVersion, 2);
        const currentSets = await setSnapshot(database);
        assert.deepEqual(
          currentSets.filter((set) => set.id !== futureId),
          originalSets.filter((set) => set.id !== futureId),
        );
        const futureRows = currentSets.filter((set) => set.id === futureId);
        assert.ok(futureRows.every((row) => row.version === 2));
        assert.deepEqual(
          futureRows.map((row) => row.question_id),
          originalSets
            .filter((set) => set.id === futureId)
            .map((row) => row.question_id),
        );
        assert.ok(
          futureRows.every(
            (row) => JSON.stringify(row.choice_order) === "[2,0,3,1]",
          ),
        );
        assert.equal(
          futureRows.filter(
            (row) => row.question_revision_id === corrected.correctedRevisionId,
          ).length,
          1,
        );
        const oldRows =
          await database.client`SELECT lifecycle_status::text FROM question_revisions WHERE id IN ${database.client(source.questions.map((row) => row.id))}`;
        assert.ok(oldRows.every((row) => row.lifecycle_status === "published"));
        const originals = await database.client<{ row: BaselineRow }[]>`
        SELECT jsonb_build_object('id', id, 'question_id', question_id, 'category', category,
          'difficulty', difficulty, 'prompt', prompt, 'choices', choices, 'correct_index', correct_index,
          'explanation', explanation, 'source_url', source_url, 'source_checked_at', source_checked_at,
          'reviewer_id', reviewer_id, 'lifecycle_status', lifecycle_status, 'time_sensitive', time_sensitive,
          'valid_until', valid_until, 'next_review_at', next_review_at) AS row
        FROM question_revisions WHERE id IN ${database.client(source.questions.map((row) => row.id))} ORDER BY id
      `;
        assert.deepEqual(
          { questions: originals.map((row) => row.row) },
          sourceBefore,
        );
        const after = await counts(database);
        assert.equal(after.audits, before.audits + 7);
      },
    );
    await context.test(
      "identical rerun adds no revision, question, set or audit rows and verifies exact corrected payload",
      async () => {
        const after = await counts(database);
        const replay = await applyContentCorrections(
          database,
          structuredClone(input),
          structuredClone(source),
          ACTOR,
          OPTIONS,
        );
        assert.equal(replay.created, 0);
        assert.equal(replay.existing, 1);
        assert.equal(replay.batch, result.batch);
        assert.equal(
          replay.sets.find((set) => set.dailySetId === futureId)?.status,
          "already_corrected",
        );
        assert.deepEqual(await counts(database), after);
        const changed = structuredClone(input);
        changed.items[0]!.payload.explanation += " Different correction.";
        await assert.rejects(
          applyContentCorrections(database, changed, source, ACTOR, OPTIONS),
          /CORRECTION_IDENTITY_CONFLICT/,
        );
        assert.deepEqual(await counts(database), after);
      },
    );
  } finally {
    await harness.close();
  }
});

test("durable set mapping detects replay drift after all five items are replaced by unrelated revisions", async () => {
  const harness = await createIntegrationHarness();
  try {
    const { database } = harness;
    const source = await baseline(database);
    const input = reviewed(source);
    const futureId = await futureSet(database, source);
    const applied = await applyContentCorrections(
      database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(
      applied.sets.find((set) => set.dailySetId === futureId)?.status,
      "corrected",
    );
    const unrelated = [];
    for (const [index, entry] of input.items.entries()) {
      const revision = await createQuestionRevision(database, ACTOR, {
        ...entry.payload,
        questionId: undefined,
        prompt: `Synthetic unrelated replacement ${index + 1}`,
      });
      for (const status of ["review", "approved", "published"] as const) {
        await updateQuestionRevisionStatus(
          database,
          ACTOR,
          revision.revisionId,
          status,
          NOW,
        );
      }
      unrelated.push({
        revisionId: revision.revisionId,
        choiceOrder: [2, 0, 3, 1] as const,
      });
    }
    await correctFutureDailySet(
      database,
      ACTOR,
      futureId,
      {
        expectedVersion: 2,
        reason: "Independent authorized replacement of every logical question",
        items: unrelated,
      },
      NOW,
    );
    const changedSet = await setSnapshot(database, futureId);
    assert.ok(
      changedSet.every(
        (item) =>
          !source.questions.some((row) => row.question_id === item.question_id),
      ),
    );
    const before = await counts(database);
    const preview = await previewContentCorrections(
      database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    const previewSet = preview.sets.find((set) => set.dailySetId === futureId)!;
    assert.equal(previewSet.status, "blocked");
    assert.deepEqual(previewSet.blockedReasons, ["SET_REPLAY_DRIFT"]);
    const replay = await applyContentCorrections(
      database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(replay.status, "partial");
    assert.equal(replay.created, 0);
    const replaySet = replay.sets.find((set) => set.dailySetId === futureId)!;
    assert.equal(replaySet.status, "blocked");
    assert.deepEqual(replaySet.blockedReasons, ["SET_REPLAY_DRIFT"]);
    assert.deepEqual(await counts(database), before);
    assert.deepEqual(await setSnapshot(database, futureId), changedSet);
    // Audit mappings have no daily-set foreign key. A missing mapped resource
    // must fail closed rather than disappear from candidate discovery.
    await database.client`
      INSERT INTO admin_audit_logs (actor_subject, action, resource_type, resource_id, metadata)
      VALUES (${ACTOR}, 'content_correction.daily_set', 'daily_set', ${randomUUID()},
        ${JSON.stringify({ batch: applied.batch, contentHash: applied.contentHash })}::jsonb)
    `;
    const withMissingMapping = await counts(database);
    await assert.rejects(
      previewContentCorrections(database, input, source, ACTOR, OPTIONS),
      /SET_REPLAY_DRIFT/,
    );
    await assert.rejects(
      applyContentCorrections(database, input, source, ACTOR, OPTIONS),
      /SET_REPLAY_DRIFT/,
    );
    assert.deepEqual(await counts(database), withMissingMapping);
  } finally {
    await harness.close();
  }
});

test("blocked or unavailable-source corrections never create or publish, even when other evidence says verified", async () => {
  const harness = await createIntegrationHarness();
  try {
    const source = await baseline(harness.database);
    const input = reviewed(source);
    const futureId = await futureSet(harness.database, source);
    input.items[0]!.decision = "blocked";
    input.items[1]!.decision = "revise";
    input.items[1]!.sourceChecks[0]!.result = "unavailable";
    input.items[1]!.sourceChecks.push({
      ...input.items[1]!.sourceChecks[0]!,
      url: "https://example.invalid/verified-auxiliary-only",
      result: "verified",
    });
    input.items[2]!.decision = "revise";
    input.items[2]!.payload.sourceUrl =
      "https://example.invalid/unchecked-primary";
    const before = await counts(harness.database);
    const oldSet = await setSnapshot(harness.database, futureId);
    const result = await applyContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(result.status, "partial");
    assert.equal(result.created, 0);
    assert.equal(
      result.items.filter((item) => item.status === "blocked").length,
      3,
    );
    assert.ok(
      result.items
        .find((item) => item.sourceRevisionId === input.items[0]!.revisionId)
        ?.blockedReasons.includes("AUDIT_ENTRY_BLOCKED"),
    );
    assert.ok(
      result.items
        .find((item) => item.sourceRevisionId === input.items[1]!.revisionId)
        ?.blockedReasons.includes("VERIFIED_SOURCES_REQUIRED"),
    );
    assert.ok(
      result.items
        .find((item) => item.sourceRevisionId === input.items[2]!.revisionId)
        ?.blockedReasons.includes("VERIFIED_SOURCES_REQUIRED"),
    );
    assert.equal(
      result.sets.find((set) => set.dailySetId === futureId)?.status,
      "blocked",
    );
    assert.deepEqual(await counts(harness.database), before);
    assert.deepEqual(await setSnapshot(harness.database, futureId), oldSet);
  } finally {
    await harness.close();
  }
});

test("verified fallback primary allows an unavailable auxiliary attempt without stripping its evidence", async () => {
  const harness = await createIntegrationHarness();
  try {
    const source = await baseline(harness.database);
    const input = reviewed(source);
    const revised = input.items[0]!;
    const auxiliary = {
      ...revised.sourceChecks[0]!,
      result: "unavailable" as const,
      evidence:
        "Original source could not be retrieved; no success is claimed.",
    };
    revised.payload.sourceUrl =
      "https://example.invalid/verified-fallback-primary";
    revised.sourceChecks = [
      auxiliary,
      {
        ...auxiliary,
        url: revised.payload.sourceUrl,
        result: "verified",
        evidence:
          "Synthetic fallback evidence supporting the corrected payload.",
      },
    ];
    const originalInput = structuredClone(input);
    const futureId = await futureSet(harness.database, source);
    const before = await counts(harness.database);
    const preview = await previewContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(
      preview.items.find((item) => item.sourceRevisionId === revised.revisionId)
        ?.status,
      "planned",
    );
    assert.equal(
      preview.sets.find((set) => set.dailySetId === futureId)?.status,
      "planned",
    );
    assert.deepEqual(await counts(harness.database), before);
    const result = await applyContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(result.status, "applied");
    assert.equal(result.created, 1);
    assert.equal(
      result.sets.find((set) => set.dailySetId === futureId)?.status,
      "corrected",
    );
    assert.deepEqual(input, originalInput);
    const corrected = result.items.find(
      (item) => item.sourceRevisionId === revised.revisionId,
    )!;
    const rows = await harness.database
      .client`SELECT source_url, lifecycle_status::text FROM question_revisions WHERE id = ${corrected.correctedRevisionId}::uuid`;
    assert.equal(rows[0]?.source_url, revised.payload.sourceUrl);
    assert.equal(rows[0]?.lifecycle_status, "published");
    const appliedCounts = await counts(harness.database);
    await applyContentCorrections(
      harness.database,
      originalInput,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.deepEqual(await counts(harness.database), appliedCounts);
    const changedEvidence = structuredClone(originalInput);
    changedEvidence.items[0]!.sourceChecks[0]!.evidence +=
      " Altered unavailable-attempt record.";
    await assert.rejects(
      applyContentCorrections(
        harness.database,
        changedEvidence,
        source,
        ACTOR,
        OPTIONS,
      ),
      /CORRECTION_IDENTITY_CONFLICT/,
    );
    assert.deepEqual(await counts(harness.database), appliedCounts);
  } finally {
    await harness.close();
  }
});

test("approved zero-hard composition previews and applies as two easy and three medium", async () => {
  const harness = await createIntegrationHarness();
  try {
    const source = await baseline(harness.database);
    const input = reviewed(source);
    for (const item of input.items) item.decision = "keep";
    const hard = input.items.find(
      (item) => item.payload.difficulty === "hard",
    )!;
    hard.decision = "revise";
    hard.payload.difficulty = "medium";
    const futureId = await futureSet(harness.database, source);
    const before = await counts(harness.database);
    const preview = await previewContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(
      preview.sets.find((set) => set.dailySetId === futureId)?.status,
      "planned",
    );
    assert.deepEqual(await counts(harness.database), before);
    const result = await applyContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(result.status, "applied");
    assert.equal(result.created, 1);
    assert.equal(
      result.sets.find((set) => set.dailySetId === futureId)?.status,
      "corrected",
    );
    const rows = await harness.database.client<
      { difficulty: string; count: number }[]
    >`
      SELECT qr.difficulty::text, count(*)::int AS count
      FROM daily_set_items dsi JOIN question_revisions qr ON qr.id = dsi.question_revision_id
      WHERE dsi.daily_set_id = ${futureId} GROUP BY qr.difficulty
    `;
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.difficulty, row.count])),
      { easy: 2, medium: 3 },
    );
    const appliedCounts = await counts(harness.database);
    const replay = await applyContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(
      replay.sets.find((set) => set.dailySetId === futureId)?.status,
      "already_corrected",
    );
    assert.deepEqual(await counts(harness.database), appliedCounts);
  } finally {
    await harness.close();
  }
});

test("missing time_sensitive is not accepted when the live revision has temporal content", async () => {
  const harness = await createIntegrationHarness();
  try {
    const request = reviewed(await baseline(harness.database)).items[0]!
      .payload;
    const created = await createQuestionRevision(harness.database, ACTOR, {
      ...request,
      questionId: undefined,
      prompt: "Synthetic temporal source requiring explicit baseline",
      timeSensitive: true,
      validUntil: "2101-01-01T00:00:00.000Z",
      nextReviewAt: "2100-01-01T00:00:00.000Z",
    });
    const source = {
      questions: (await baseline(harness.database)).questions.filter(
        (row) => row.id === created.revisionId,
      ),
    };
    const input = reviewed(source);
    delete source.questions[0]!.time_sensitive;
    const options = { ...OPTIONS, expectedCount: 1 };
    const before = await counts(harness.database);
    const preview = await previewContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      options,
    );
    assert.ok(
      preview.items[0]!.blockedReasons.includes(
        "BASELINE_TIME_SENSITIVE_MISSING",
      ),
    );
    await assert.rejects(
      applyContentCorrections(harness.database, input, source, ACTOR, options),
      /BASELINE_TIME_SENSITIVE_REQUIRED/,
    );
    assert.deepEqual(await counts(harness.database), before);
  } finally {
    await harness.close();
  }
});

test("invalid future composition still permits a valid editorial revision but explicitly leaves the set unchanged", async () => {
  const harness = await createIntegrationHarness();
  try {
    const source = await baseline(harness.database);
    const input = reviewed(source);
    input.items[0]!.payload.difficulty = "hard";
    const futureId = await futureSet(harness.database, source);
    const before = await setSnapshot(harness.database, futureId);
    const result = await applyContentCorrections(
      harness.database,
      input,
      source,
      ACTOR,
      OPTIONS,
    );
    assert.equal(result.created, 1);
    assert.equal(result.status, "partial");
    const future = result.sets.find((set) => set.dailySetId === futureId)!;
    assert.equal(future.status, "blocked");
    assert.ok(
      future.blockedReasons.includes(
        "DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID",
      ),
    );
    assert.deepEqual(await setSnapshot(harness.database, futureId), before);
    const corrected = result.items.find((item) => item.decision === "revise")!;
    const rows = await harness.database
      .client`SELECT difficulty::text, lifecycle_status::text FROM question_revisions WHERE id = ${corrected.correctedRevisionId}::uuid`;
    assert.equal(rows[0]?.difficulty, "hard");
    assert.equal(rows[0]?.lifecycle_status, "published");
  } finally {
    await harness.close();
  }
});

test("draft correction remains draft and creation plus mapping rollback together on an injected middle failure", async (context) => {
  const harness = await createIntegrationHarness();
  try {
    const { database } = harness;
    const seed = await baseline(database);
    const draftRequest = reviewed(seed).items[0]!.payload;
    const draft = await createQuestionRevision(database, ACTOR, {
      ...draftRequest,
      questionId: undefined,
      prompt: "Synthetic draft-only editorial source",
      sourceUrl: "https://example.invalid/editorial-draft",
    });
    const source = await baseline(database);
    const input = reviewed(source);
    const draftItem = input.items.find(
      (item) => item.revisionId === draft.revisionId,
    )!;
    draftItem.decision = "revise";
    draftItem.payload.explanation += " Draft-only clarification.";
    const publishedItem = input.items.find(
      (item) =>
        source.questions.find((row) => row.id === item.revisionId)!
          .lifecycle_status === "published",
    )!;
    publishedItem.decision = "revise";
    publishedItem.payload.explanation += " Published-source clarification.";
    const options = { ...OPTIONS, expectedCount: 6 };
    await context.test(
      "a late database failure rolls back earlier creations, status audits and mapping records",
      async () => {
        const revised = input.items
          .filter((item) => item.decision === "revise")
          .sort((a, b) => a.revisionId.localeCompare(b.revisionId));
        const lastPrompt = revised.at(-1)!.payload.prompt;
        await database.client`CREATE TABLE editorial_rejected_prompt (prompt text NOT NULL)`;
        await database.client`INSERT INTO editorial_rejected_prompt VALUES (${lastPrompt})`;
        await database.client`
        CREATE FUNCTION reject_editorial_revision() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM editorial_rejected_prompt WHERE prompt = NEW.prompt) THEN
            RAISE EXCEPTION 'private database diagnostic and credential';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
        await database.client`CREATE TRIGGER reject_editorial_revision BEFORE INSERT ON question_revisions FOR EACH ROW EXECUTE FUNCTION reject_editorial_revision()`;
        const before = await counts(database);
        try {
          await assert.rejects(
            applyContentCorrections(database, input, source, ACTOR, options),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.equal(error.message, "CONTENT_CORRECTIONS_FAILED");
              return true;
            },
          );
          assert.deepEqual(await counts(database), before);
        } finally {
          await database.client`DROP TRIGGER reject_editorial_revision ON question_revisions`;
          await database.client`DROP FUNCTION reject_editorial_revision()`;
          await database.client`DROP TABLE editorial_rejected_prompt`;
        }
      },
    );
    const result = await applyContentCorrections(
      database,
      input,
      source,
      ACTOR,
      options,
    );
    const correction = result.items.find(
      (item) => item.sourceRevisionId === draft.revisionId,
    )!;
    assert.equal(correction.targetStatus, "draft");
    assert.equal(correction.status, "created");
    const rows =
      await database.client`SELECT question_id, lifecycle_status::text, published_at, retired_at FROM question_revisions WHERE id = ${correction.correctedRevisionId}::uuid`;
    assert.equal(rows[0]?.question_id, draft.questionId);
    assert.equal(rows[0]?.lifecycle_status, "draft");
    assert.equal(rows[0]?.published_at, null);
    assert.equal(rows[0]?.retired_at, null);
    const before = await counts(database);
    const replay = await applyContentCorrections(
      database,
      input,
      source,
      ACTOR,
      options,
    );
    assert.equal(replay.created, 0);
    assert.deepEqual(await counts(database), before);
    // The mapped draft is mutable at the DB level, so replay must independently
    // verify the exact editorial payload before performing another mutation.
    await database.client`UPDATE question_revisions SET explanation = 'Unexpected draft drift' WHERE id = ${correction.correctedRevisionId}::uuid`;
    const drifted = await counts(database);
    await assert.rejects(
      applyContentCorrections(database, input, source, ACTOR, options),
      /CORRECTED_PAYLOAD_DRIFT/,
    );
    assert.deepEqual(await counts(database), drifted);
  } finally {
    await harness.close();
  }
});
