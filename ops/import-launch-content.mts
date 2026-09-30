import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  AdminCreateQuestionRevisionRequestSchema,
  type AdminCreateQuestionRevisionRequest,
} from "../packages/contracts/src/index.js";
import { createQuestionRevision } from "../apps/api/src/admin/content-service.js";
import type { Database, SqlClient } from "../apps/api/src/db/client.js";

const BATCH = "launch-content-165-v1";
const IMPORT_ACTION = "question_revision.create";
type Transaction = Parameters<Parameters<SqlClient["begin"]>[1]>[0];
type Draft = { localId: string; request: AdminCreateQuestionRevisionRequest };
export interface LaunchContentReceipt {
  batch: string;
  mode: "apply" | "preview";
  created: number;
  existing: number;
  items: {
    localId: string;
    questionId: string | null;
    revisionId: string | null;
  }[];
}

function validate(drafts: unknown, actorSubject: string): Draft[] {
  if (!actorSubject.trim() || actorSubject.length > 100)
    throw new Error("Invalid actor subject");
  if (!Array.isArray(drafts) || drafts.length !== 165)
    throw new Error("Exactly 165 drafts required");
  const ids = new Set<string>();
  const prompts = new Set<string>();
  return drafts.map((draft: unknown) => {
    if (
      typeof draft !== "object" ||
      draft === null ||
      !("localId" in draft) ||
      !("request" in draft)
    )
      throw new Error("Invalid draft entry");
    const { localId } = draft;
    if (
      typeof localId !== "string" ||
      !/^[A-Z]+-[0-9]{3}$/.test(localId) ||
      ids.has(localId)
    )
      throw new Error("Invalid or duplicate localId");
    const parsed = AdminCreateQuestionRevisionRequestSchema.safeParse(
      draft.request,
    );
    if (!parsed.success || parsed.data.questionId !== undefined)
      throw new Error("Invalid draft request");
    const key = JSON.stringify([parsed.data.category, parsed.data.prompt]);
    if (prompts.has(key)) throw new Error("Duplicate prompt/category");
    ids.add(localId);
    prompts.add(key);
    return { localId, request: parsed.data };
  });
}

function canonical(request: AdminCreateQuestionRevisionRequest): string {
  return JSON.stringify([
    request.category,
    request.difficulty,
    request.prompt,
    request.choices,
    request.correctIndex,
    request.explanation,
    request.sourceUrl,
    new Date(request.sourceCheckedAt).toISOString(),
    request.reviewerId,
    request.timeSensitive,
    request.validUntil === null
      ? null
      : new Date(request.validUntil).toISOString(),
    request.nextReviewAt === null
      ? null
      : new Date(request.nextReviewAt).toISOString(),
  ]);
}

async function execute(
  database: Database,
  drafts: unknown,
  actorSubject: string,
  apply: boolean,
): Promise<LaunchContentReceipt> {
  // Validate the complete batch before opening a transaction or performing any writes.
  const entries = validate(drafts, actorSubject);
  const result = await database.client.begin(
    apply ? "" : "read only",
    async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(1835627636, 165)`;
      const mappings = await transaction<
        { local_id: string; revision_id: string }[]
      >`
      SELECT metadata->>'localId' AS local_id, resource_id AS revision_id
      FROM admin_audit_logs WHERE action = ${IMPORT_ACTION} AND metadata->>'batch' = ${BATCH}
    `;
      if (
        mappings.length !== 0 &&
        (mappings.length !== 165 ||
          new Set(mappings.map((item) => item.local_id)).size !== 165 ||
          new Set(mappings.map((item) => item.revision_id)).size !== 165)
      )
        throw new Error("Partial or ambiguous import mappings");
      const items: LaunchContentReceipt["items"] = [];
      for (const entry of entries) {
        const mapping = mappings.find(
          (item) => item.local_id === entry.localId,
        );
        if (mappings.length > 0 && mapping === undefined)
          throw new Error("Import identity mismatch");
        const rows = await transaction<
          {
            id: string;
            question_id: string;
            revision_number: number;
            lifecycle_status: string;
            published_at: unknown;
            retired_at: unknown;
            request: AdminCreateQuestionRevisionRequest;
          }[]
        >`
        SELECT id, question_id, revision_number, lifecycle_status, published_at, retired_at,
          jsonb_build_object('category', category, 'difficulty', difficulty, 'prompt', prompt,
            'choices', choices, 'correctIndex', correct_index, 'explanation', explanation,
            'sourceUrl', source_url, 'sourceCheckedAt', source_checked_at, 'reviewerId', reviewer_id,
            'timeSensitive', time_sensitive, 'validUntil', valid_until, 'nextReviewAt', next_review_at) AS request
        FROM question_revisions
        WHERE (category = ${entry.request.category} AND prompt = ${entry.request.prompt})
          OR id = ${mapping?.revision_id ?? null}::uuid
      `;
        if (mapping === undefined) {
          if (rows.length !== 0)
            throw new Error("Existing content without import identity");
          items.push({
            localId: entry.localId,
            questionId: null,
            revisionId: null,
          });
        } else {
          const row = rows[0];
          if (
            rows.length !== 1 ||
            row === undefined ||
            row.id !== mapping.revision_id ||
            row.revision_number !== 1 ||
            row.lifecycle_status !== "draft" ||
            row.published_at !== null ||
            row.retired_at !== null ||
            canonical(row.request) !== canonical(entry.request)
          )
            throw new Error("Existing import payload or state mismatch");
          items.push({
            localId: entry.localId,
            questionId: row.question_id,
            revisionId: row.id,
          });
        }
      }
      if (apply && mappings.length === 0) {
        // The service begins its own transaction; map that boundary to a savepoint
        // so service inserts and audit records remain inside this batch transaction.
        const client = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "begin")
              return (callback: (sql: Transaction) => Promise<unknown>) =>
                target.savepoint(callback);
            return Reflect.get(target, property, receiver);
          },
        }) as unknown as SqlClient;
        const scopedDatabase = { ...database, client };
        for (const [index, entry] of entries.entries()) {
          const created = await createQuestionRevision(
            scopedDatabase,
            actorSubject,
            entry.request,
          );
          await transaction`
          UPDATE admin_audit_logs
          SET metadata = metadata || ${JSON.stringify({ batch: BATCH, localId: entry.localId })}::jsonb
          WHERE resource_id = ${created.revisionId} AND action = ${IMPORT_ACTION}
            AND actor_subject = ${actorSubject}
        `;
          items[index] = {
            localId: entry.localId,
            questionId: created.questionId,
            revisionId: created.revisionId,
          };
        }
      }
      return {
        batch: BATCH,
        mode: apply ? ("apply" as const) : ("preview" as const),
        created: apply && mappings.length === 0 ? 165 : 0,
        existing: mappings.length,
        items,
      };
    },
  );
  return result as LaunchContentReceipt;
}

export function importLaunchContent(
  database: Database,
  drafts: unknown,
  actorSubject: string,
): Promise<LaunchContentReceipt> {
  return execute(database, drafts, actorSubject, true);
}

export function previewLaunchContent(
  database: Database,
  drafts: unknown,
  actorSubject: string,
): Promise<LaunchContentReceipt> {
  return execute(database, drafts, actorSubject, false);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      actor: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.input || !values.output || !values.actor)
    throw new Error("Required CLI arguments missing");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL required");
  const url = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Invalid database protocol");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !local &&
    (url.searchParams.getAll("sslmode").length !== 1 ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  )
    throw new Error("Verified database TLS required");
  // postgres.js accepts alternate connection destinations in query parameters.
  for (const key of [
    "host",
    "hostaddr",
    "port",
    "ssl",
    "sslrootcert",
    "sslcert",
    "sslkey",
  ]) {
    if (url.searchParams.has(key))
      throw new Error("Connection override parameters are not supported");
  }
  const inventory: unknown = JSON.parse(await readFile(values.input, "utf8"));
  if (
    typeof inventory !== "object" ||
    inventory === null ||
    !("drafts" in inventory)
  )
    throw new Error("Invalid inventory");
  validate(inventory.drafts, values.actor);
  // Exclusive creation happens before database writes; existing receipts are never overwritten.
  const output = await open(values.output, "wx", 0o600);
  let client: SqlClient | undefined;
  try {
    const require = createRequire(
      new URL("../apps/api/package.json", import.meta.url),
    );
    const postgres = require("postgres") as (
      connection: string,
      options: Record<string, unknown>,
    ) => SqlClient;
    client = postgres(rawUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      ssl: local ? undefined : "verify-full",
    });
    const { drizzle } = require("drizzle-orm/postgres-js") as {
      drizzle(sql: SqlClient): Database["orm"];
    };
    const database: Database = {
      client,
      orm: drizzle(client),
      close: () => client!.end({ timeout: 5 }),
    };
    const receipt = await execute(
      database,
      inventory.drafts,
      values.actor,
      values.apply,
    );
    await output.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    await output.close();
    await client?.end({ timeout: 5 });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    // Never serialize database exceptions, input payloads, paths, or connection credentials.
    console.error(
      "Content import failed; no approval or publication was requested. A reserved receipt may be empty; use a new receipt filename for a safe rerun.",
    );
    process.exitCode = 1;
  });
}
