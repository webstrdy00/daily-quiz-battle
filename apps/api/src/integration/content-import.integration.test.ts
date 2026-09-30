import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  importLaunchContent,
  previewLaunchContent,
} from "../../../../ops/import-launch-content.mjs";
import type { AdminCreateQuestionRevisionRequest } from "@daily-quiz-battle/contracts";
import { createIntegrationHarness } from "./test-harness.js";

test("launch import validates, rolls back, remains draft, and rejects changed reruns", async (context) => {
  const harness = await createIntegrationHarness();
  const { database } = harness;
  const inventory = JSON.parse(
    await readFile(
      new URL(
        "../../../../docs/development/launch-content-cms-drafts.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    drafts: { localId: string; request: AdminCreateQuestionRevisionRequest }[];
  };
  const actor = "integration-launch-import";
  const counts = async () => {
    const rows = await database.client`
      SELECT (SELECT count(*)::int FROM questions) AS questions,
        (SELECT count(*)::int FROM question_revisions) AS revisions,
        (SELECT count(*)::int FROM admin_audit_logs) AS audits,
        (SELECT count(*)::int FROM daily_sets) AS daily_sets
    `;
    return { ...rows[0] };
  };
  try {
    const baseline = await counts();
    await context.test(
      "invalid middle request and duplicate IDs cause zero writes",
      async () => {
        const invalid = structuredClone(inventory.drafts);
        (invalid[82]!.request as { correctIndex: number }).correctIndex = 99;
        await assert.rejects(
          importLaunchContent(database, invalid, actor),
          /Invalid draft request/,
        );
        const duplicate = structuredClone(inventory.drafts);
        duplicate[82]!.localId = duplicate[0]!.localId;
        await assert.rejects(
          importLaunchContent(database, duplicate, actor),
          /duplicate localId/,
        );
        await assert.rejects(
          importLaunchContent(database, inventory.drafts.slice(1), actor),
          /Exactly 165/,
        );
        assert.deepEqual(await counts(), baseline);
      },
    );
    await context.test("preview performs no writes", async () => {
      const receipt = await previewLaunchContent(
        database,
        inventory.drafts,
        actor,
      );
      assert.equal(receipt.mode, "preview");
      assert.equal(receipt.items.length, 165);
      assert.equal(receipt.created, 0);
      assert.ok(receipt.items.every((item) => item.revisionId === null));
      assert.deepEqual(await counts(), baseline);
    });
    await context.test(
      "database failure after earlier service inserts rolls back whole batch",
      async () => {
        // A persistent trigger uses the known middle prompt, independent of pooled sessions.
        await database.client`CREATE TABLE import_rejected_prompt (prompt text NOT NULL)`;
        await database.client`INSERT INTO import_rejected_prompt VALUES (${inventory.drafts[82]!.request.prompt})`;
        await database.client`
        CREATE OR REPLACE FUNCTION reject_import_middle() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM import_rejected_prompt WHERE prompt = NEW.prompt) THEN
            RAISE EXCEPTION 'injected import failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
        await database.client`CREATE TRIGGER reject_import_middle BEFORE INSERT ON question_revisions FOR EACH ROW EXECUTE FUNCTION reject_import_middle()`;
        try {
          await assert.rejects(
            importLaunchContent(database, inventory.drafts, actor),
            /injected import failure/,
          );
          assert.deepEqual(await counts(), baseline);
        } finally {
          await database.client`DROP TRIGGER reject_import_middle ON question_revisions`;
          await database.client`DROP FUNCTION reject_import_middle()`;
          await database.client`DROP TABLE import_rejected_prompt`;
        }
      },
    );
    const receipt = await importLaunchContent(
      database,
      inventory.drafts,
      actor,
    );
    await context.test(
      "165 draft revisions and service audit records with import identity",
      async () => {
        assert.equal(receipt.created, 165);
        assert.equal(receipt.existing, 0);
        assert.equal(
          new Set(receipt.items.map((item) => item.questionId)).size,
          165,
        );
        const after = await counts();
        assert.equal(after.questions, baseline.questions + 165);
        assert.equal(after.revisions, baseline.revisions + 165);
        assert.equal(after.audits, baseline.audits + 165);
        assert.equal(after.daily_sets, baseline.daily_sets);
        const rows = await database.client`
        SELECT r.lifecycle_status, r.published_at, r.retired_at, a.action, a.metadata
        FROM question_revisions r JOIN admin_audit_logs a ON a.resource_id = r.id
        WHERE a.actor_subject = ${actor}
      `;
        assert.equal(rows.length, 165);
        assert.ok(
          rows.every(
            (row) =>
              row.lifecycle_status === "draft" &&
              row.published_at === null &&
              row.retired_at === null,
          ),
        );
        assert.equal(
          rows.filter((row) => row.action === "question_revision.create")
            .length,
          165,
        );
        assert.equal(
          new Set(rows.map((row) => row.metadata.localId)).size,
          165,
        );
        assert.ok(rows.every((row) => row.metadata.batch === receipt.batch));
      },
    );
    await context.test("repeat reuses IDs without any writes", async () => {
      const before = await counts();
      const repeat = await importLaunchContent(
        database,
        inventory.drafts,
        actor,
      );
      assert.equal(repeat.created, 0);
      assert.equal(repeat.existing, 165);
      assert.deepEqual(repeat.items, receipt.items);
      assert.deepEqual(await counts(), before);
    });
    await context.test(
      "changed input prompt is rejected using stable audit identity",
      async () => {
        const before = await counts();
        const altered = structuredClone(inventory.drafts);
        altered[82]!.request.prompt += " changed";
        await assert.rejects(
          importLaunchContent(database, altered, actor),
          /payload or state mismatch/,
        );
        assert.deepEqual(await counts(), before);
      },
    );
    await context.test(
      "altered existing payload is not overwritten or duplicated",
      async () => {
        const revisionId = receipt.items[82]!.revisionId;
        await database.client`UPDATE question_revisions SET explanation = 'altered existing explanation' WHERE id = ${revisionId}::uuid`;
        const before = await counts();
        await assert.rejects(
          importLaunchContent(database, inventory.drafts, actor),
          /payload or state mismatch/,
        );
        assert.deepEqual(await counts(), before);
        const rows =
          await database.client`SELECT explanation FROM question_revisions WHERE id = ${revisionId}::uuid`;
        assert.equal(rows[0]?.explanation, "altered existing explanation");
      },
    );
  } finally {
    await harness.close();
  }
});
