// Preview (read only) is the default. --apply is the only write opt-in.
// --input PATH: {items:[...]} merged from the four reviewed category files (165 rows).
// --baseline PATH: {questions:[...]} source snapshot. Absent time_sensitive requires
// a live DB false value and null temporal metadata in both baseline and DB.
// --url-file PATH --ca-file PATH --receipt-file PATH --actor SUBJECT [--apply]
// Run with the API's existing tsx: pnpm --filter @daily-quiz-battle/api exec tsx ../../ops/apply-content-corrections.mts ...
// Receipts are exclusively created. Use a new filename when resuming an interrupted run.
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  AdminCreateQuestionRevisionRequestSchema,
  ChoiceOrderSchema,
  IsoDateTimeSchema,
  UuidSchema,
  type AdminCreateQuestionRevisionRequest,
  type ContentStatus,
} from "../packages/contracts/src/index.js";
import {
  createQuestionRevision,
  updateQuestionRevisionStatus,
} from "../apps/api/src/admin/content-service.js";
import { correctFutureDailySet } from "../apps/api/src/admin/correction-service.js";
import type { Database, SqlClient } from "../apps/api/src/db/client.js";
import { AppError } from "../apps/api/src/shared/errors.js";
import { getKstDate } from "../apps/api/src/shared/time.js";

type Transaction = Parameters<Parameters<SqlClient["begin"]>[1]>[0];
type Decision = "keep" | "revise" | "blocked";
type Payload = AdminCreateQuestionRevisionRequest;
interface Entry {
  revisionId: string;
  questionId: string;
  decision: Decision;
  issues: string[];
  changes: string[];
  sourceChecks: {
    url: string;
    result: "verified" | "unavailable";
    evidence: string;
    checkedAt: string;
  }[];
  payload: Payload;
}
interface SourceRow {
  id: string;
  question_id: string;
  revision_number?: number;
  lifecycle_status: ContentStatus;
  published_at?: Date | string | null;
  retired_at?: Date | string | null;
  created_at?: Date | string;
  request: Payload;
  missingTimeSensitive?: boolean;
}
interface MappingRow {
  id: string;
  resource_id: string;
  metadata: Record<string, unknown>;
}
interface SetItem {
  position: number;
  revision_id: string;
  question_id: string;
  choice_order: [number, number, number, number];
  category: string;
  difficulty: "easy" | "medium" | "hard";
  lifecycle_status: ContentStatus;
  time_sensitive: boolean;
  valid_until: Date | string | null;
}
interface SetRow {
  id: string;
  quiz_date: string;
  version: number;
  status: string;
  has_attempts: boolean;
  has_challenges: boolean;
  is_void: boolean;
  items: SetItem[];
}
interface Prepared {
  entries: Entry[];
  sources: Map<string, SourceRow>;
  mappings: Map<string, MappingRow>;
  corrected: Map<string, SourceRow>;
  blocked: Map<string, string[]>;
  batch: string;
  contentHash: string;
  warnings: string[];
}
export interface ContentCorrectionsReceipt {
  batch: string;
  contentHash: string;
  mode: "preview" | "apply";
  status: "preview" | "applied" | "partial";
  created: number;
  existing: number;
  warnings: string[];
  items: {
    sourceRevisionId: string;
    questionId: string;
    decision: Decision;
    correctedRevisionId: string | null;
    targetStatus: "draft" | "published" | null;
    status: "keep" | "blocked" | "planned" | "created" | "existing";
    blockedReasons: string[];
    historicalSetUnchanged: boolean;
  }[];
  sets: {
    dailySetId: string;
    quizDate: string;
    expectedVersion: number;
    resultVersion: number | null;
    status:
      | "planned"
      | "corrected"
      | "already_corrected"
      | "historical_set_unchanged"
      | "nonpublished_set_unchanged"
      | "blocked";
    blockedReasons: string[];
    items: {
      position: number;
      questionId: string;
      fromRevisionId: string;
      toRevisionId: string | null;
      choiceOrder: [number, number, number, number];
    }[];
  }[];
}
export interface ContentCorrectionsOptions {
  // Test-only small fixtures; the CLI always requires exactly 165.
  expectedCount?: number;
  now?: Date;
}
const REVISION_ACTION = "content_correction.revision";
const SET_ACTION = "content_correction.daily_set";
const PAYLOAD_KEYS = [
  "questionId",
  "category",
  "difficulty",
  "prompt",
  "choices",
  "correctIndex",
  "explanation",
  "sourceUrl",
  "sourceCheckedAt",
  "reviewerId",
  "timeSensitive",
  "validUntil",
  "nextReviewAt",
];

class CorrectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ContentCorrectionError";
  }
}
function fail(code: string): never {
  throw new CorrectionError(code);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_INPUT");
  return value as Record<string, unknown>;
}
function iso(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== "string")
    fail("INVALID_TIMESTAMP");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("INVALID_TIMESTAMP");
  return date.toISOString();
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function canonical(request: Payload): string {
  return stable({
    ...request,
    questionId: undefined,
    sourceCheckedAt: iso(request.sourceCheckedAt),
    validUntil: request.validUntil === null ? null : iso(request.validUntil),
    nextReviewAt:
      request.nextReviewAt === null ? null : iso(request.nextReviewAt),
  });
}
function payload(value: unknown): Payload {
  const raw = object(value);
  const parsed = AdminCreateQuestionRevisionRequestSchema.safeParse(raw);
  if (
    !parsed.success ||
    Object.keys(raw).some((key) => !PAYLOAD_KEYS.includes(key))
  )
    fail("INVALID_PAYLOAD");
  // Reject silently normalized fields rather than hashing a different editorial request.
  if (canonical(raw as unknown as Payload) !== canonical(parsed.data))
    fail("NONCANONICAL_PAYLOAD");
  return parsed.data;
}
function textList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    fail("INVALID_REVIEW_NOTES");
  return value as string[];
}
function sourceUrl(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_SOURCE_CHECK");
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      fail("INVALID_SOURCE_CHECK");
  } catch {
    fail("INVALID_SOURCE_CHECK");
  }
  return value;
}
function validate(
  input: unknown,
  baseline: unknown,
  actor: string,
  count: number,
): { entries: Entry[]; sources: Map<string, SourceRow>; warnings: string[] } {
  if (
    !actor.trim() ||
    actor !== actor.trim() ||
    actor.length > 100 ||
    /[\r\n\0]/.test(actor)
  )
    fail("INVALID_ACTOR");
  if (!Number.isInteger(count) || count < 1) fail("INVALID_EXPECTED_COUNT");
  const rawItems = object(input).items;
  const rawSources = object(baseline).questions;
  if (
    !Array.isArray(rawItems) ||
    rawItems.length !== count ||
    !Array.isArray(rawSources) ||
    rawSources.length !== count
  )
    fail("INCOMPLETE_AUDIT_BASELINE");
  const sources = new Map<string, SourceRow>();
  const warnings: string[] = [];
  const sourceQuestions = new Set<string>();
  for (const value of rawSources) {
    const row = object(value);
    if (
      !UuidSchema.safeParse(row.id).success ||
      !UuidSchema.safeParse(row.question_id).success ||
      sources.has(String(row.id)) ||
      sourceQuestions.has(String(row.question_id))
    )
      fail("INVALID_BASELINE_IDENTITY");
    if (
      !["draft", "review", "approved", "published", "retired"].includes(
        String(row.lifecycle_status),
      )
    )
      fail("INVALID_BASELINE_STATUS");
    const missing = row.time_sensitive === undefined;
    // This placeholder compares captured fields only. A missing field is accepted
    // later only after checking the live DB value and both temporal fields.
    const request = payload({
      questionId: row.question_id,
      category: row.category,
      difficulty: row.difficulty,
      prompt: row.prompt,
      choices: row.choices,
      correctIndex: row.correct_index,
      explanation: row.explanation,
      sourceUrl: row.source_url,
      sourceCheckedAt: row.source_checked_at,
      reviewerId: row.reviewer_id,
      timeSensitive: missing ? false : row.time_sensitive,
      validUntil: row.valid_until,
      nextReviewAt: row.next_review_at,
    });
    if (missing)
      warnings.push(`BASELINE_TIME_SENSITIVE_MISSING:${String(row.id)}`);
    if (
      row.revision_number !== undefined &&
      (typeof row.revision_number !== "number" ||
        !Number.isInteger(row.revision_number) ||
        row.revision_number < 1)
    )
      fail("INVALID_BASELINE_IDENTITY");
    const capturedIdentity = {
      revision_number: row.revision_number as number | undefined,
      published_at:
        row.published_at === undefined || row.published_at === null
          ? row.published_at
          : iso(row.published_at),
      retired_at:
        row.retired_at === undefined || row.retired_at === null
          ? row.retired_at
          : iso(row.retired_at),
      created_at:
        row.created_at === undefined ? undefined : iso(row.created_at),
    };
    sources.set(String(row.id), {
      id: String(row.id),
      question_id: String(row.question_id),
      lifecycle_status: row.lifecycle_status as ContentStatus,
      ...capturedIdentity,
      request,
      missingTimeSensitive: missing,
    });
    sourceQuestions.add(String(row.question_id));
  }
  const ids = new Set<string>();
  const entries = rawItems
    .map((value): Entry => {
      const row = object(value);
      if (
        !UuidSchema.safeParse(row.revisionId).success ||
        !UuidSchema.safeParse(row.questionId).success ||
        ids.has(String(row.revisionId))
      )
        fail("INVALID_OR_DUPLICATE_SOURCE_ID");
      const source = sources.get(String(row.revisionId));
      if (!source || source.question_id !== row.questionId)
        fail("UNKNOWN_SOURCE_REFERENCE");
      if (!["keep", "revise", "blocked"].includes(String(row.decision)))
        fail("INVALID_DECISION");
      const request = payload(row.payload);
      if (
        (request.questionId !== undefined &&
          request.questionId !== row.questionId) ||
        (row.decision === "revise" && request.questionId !== row.questionId)
      )
        fail("QUESTION_IDENTITY_MISMATCH");
      if (!Array.isArray(row.sourceChecks)) fail("INVALID_SOURCE_CHECK");
      const sourceChecks = row.sourceChecks.map((value) => {
        const check = object(value);
        if (
          !["verified", "unavailable"].includes(String(check.result)) ||
          typeof check.evidence !== "string" ||
          !check.evidence.trim() ||
          !IsoDateTimeSchema.safeParse(check.checkedAt).success
        )
          fail("INVALID_SOURCE_CHECK");
        return {
          url: sourceUrl(check.url),
          result: check.result as "verified" | "unavailable",
          evidence: check.evidence,
          checkedAt: iso(check.checkedAt),
        };
      });
      sourceUrl(request.sourceUrl);
      ids.add(String(row.revisionId));
      return {
        revisionId: String(row.revisionId),
        questionId: String(row.questionId),
        decision: row.decision as Decision,
        issues: textList(row.issues),
        changes: textList(row.changes),
        sourceChecks,
        payload: request,
      };
    })
    .sort((left, right) => left.revisionId.localeCompare(right.revisionId));
  return { entries, sources, warnings };
}
function scoped(database: Database, transaction: Transaction): Database {
  const client = new Proxy(transaction, {
    get(target, property, receiver) {
      if (property === "begin")
        return (callback: (sql: Transaction) => Promise<unknown>) =>
          target.savepoint(callback);
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as SqlClient;
  return { ...database, client };
}
async function readRevisions(
  transaction: Transaction,
  ids: string[],
  lock: boolean,
): Promise<SourceRow[]> {
  return transaction<SourceRow[]>`
    SELECT id, question_id, revision_number::int, lifecycle_status::text, published_at, retired_at, created_at,
      jsonb_build_object('questionId', question_id, 'category', category, 'difficulty', difficulty,
        'prompt', prompt, 'choices', choices, 'correctIndex', correct_index, 'explanation', explanation,
        'sourceUrl', source_url, 'sourceCheckedAt', source_checked_at, 'reviewerId', reviewer_id,
        'timeSensitive', time_sensitive, 'validUntil', valid_until, 'nextReviewAt', next_review_at) AS request
    FROM question_revisions WHERE id IN ${transaction(ids)} ORDER BY id
    ${lock ? transaction`FOR UPDATE` : transaction``}
  `;
}
async function prepare(
  transaction: Transaction,
  input: unknown,
  baseline: unknown,
  actor: string,
  options: ContentCorrectionsOptions,
  apply: boolean,
): Promise<Prepared> {
  const validated = validate(
    input,
    baseline,
    actor,
    options.expectedCount ?? 165,
  );
  const contentHash = hash({
    version: 1,
    entries: validated.entries,
    sources: [...validated.sources.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        questionId: row.question_id,
        status: row.lifecycle_status,
        revisionNumber: row.revision_number,
        publishedAt: row.published_at,
        retiredAt: row.retired_at,
        createdAt: row.created_at,
        payload: canonical(row.request),
        missingTimeSensitive: row.missingTimeSensitive,
      })),
  });
  const batch = `content-corrections-v1-${contentHash}`;
  const actual = await readRevisions(
    transaction,
    validated.entries.map((entry) => entry.revisionId),
    apply,
  );
  if (actual.length !== validated.entries.length)
    fail("SOURCE_REVISION_NOT_FOUND");
  for (const row of actual) {
    const expected = validated.sources.get(row.id)!;
    const comparison = expected.missingTimeSensitive
      ? { ...row.request, timeSensitive: expected.request.timeSensitive }
      : row.request;
    if (
      row.question_id !== expected.question_id ||
      row.lifecycle_status !== expected.lifecycle_status ||
      canonical(comparison) !== canonical(expected.request)
    )
      fail("SOURCE_DRIFT");
    if (
      expected.revision_number !== undefined &&
      expected.revision_number !== row.revision_number
    )
      fail("SOURCE_DRIFT");
    for (const field of ["published_at", "retired_at", "created_at"] as const) {
      if (
        expected[field] !== undefined &&
        (expected[field] === null
          ? row[field] !== null
          : row[field] == null || iso(expected[field]) !== iso(row[field]))
      )
        fail("SOURCE_DRIFT");
    }
    const unresolvedTimeSensitive =
      expected.missingTimeSensitive &&
      !(
        row.request.timeSensitive === false &&
        expected.request.validUntil === null &&
        expected.request.nextReviewAt === null &&
        row.request.validUntil === null &&
        row.request.nextReviewAt === null
      );
    if (unresolvedTimeSensitive && apply)
      fail("BASELINE_TIME_SENSITIVE_REQUIRED");
    if (expected.missingTimeSensitive && !unresolvedTimeSensitive) {
      const warningIndex = validated.warnings.indexOf(
        `BASELINE_TIME_SENSITIVE_MISSING:${row.id}`,
      );
      validated.warnings[warningIndex] =
        `BASELINE_TIME_SENSITIVE_DB_FALSE_VERIFIED:${row.id}`;
    }
    validated.sources.set(row.id, {
      ...row,
      missingTimeSensitive: unresolvedTimeSensitive,
    });
  }
  const records = await transaction<MappingRow[]>`
    SELECT id, resource_id, metadata FROM admin_audit_logs
    WHERE action = ${REVISION_ACTION}
      AND metadata->>'sourceRevisionId' IN ${transaction(validated.entries.map((entry) => entry.revisionId))}
    ORDER BY id
  `;
  const mappings = new Map<string, MappingRow>();
  const corrected = new Map<string, SourceRow>();
  const mappedRevisions = records.length
    ? await readRevisions(
        transaction,
        records.map((row) => row.resource_id),
        apply,
      )
    : [];
  for (const record of records) {
    const sourceId = String(record.metadata.sourceRevisionId);
    const entry = validated.entries.find(
      (item) => item.revisionId === sourceId,
    )!;
    const row = mappedRevisions.find((item) => item.id === record.resource_id);
    const expectedStatus =
      validated.sources.get(sourceId)!.lifecycle_status === "published"
        ? "published"
        : "draft";
    if (
      mappings.has(sourceId) ||
      record.metadata.batch !== batch ||
      record.metadata.contentHash !== contentHash ||
      record.metadata.payloadHash !== hash(canonical(entry.payload)) ||
      record.metadata.questionId !== entry.questionId ||
      record.metadata.targetStatus !== expectedStatus ||
      entry.decision !== "revise"
    )
      fail("CORRECTION_IDENTITY_CONFLICT");
    if (
      !row ||
      row.question_id !== entry.questionId ||
      row.revision_number !== record.metadata.revisionNumber ||
      canonical(row.request) !== canonical(entry.payload) ||
      row.retired_at !== null ||
      (row.lifecycle_status === "published") !== (row.published_at !== null)
    )
      fail("CORRECTED_PAYLOAD_DRIFT");
    if (record.metadata.stage === "ready") {
      if (row.lifecycle_status !== expectedStatus)
        fail("CORRECTED_STATUS_DRIFT");
    } else if (
      record.metadata.stage !== "created" ||
      (expectedStatus === "draft"
        ? row.lifecycle_status !== "draft"
        : !["draft", "review", "approved", "published"].includes(
            row.lifecycle_status,
          ))
    )
      fail("CORRECTION_STAGE_INVALID");
    mappings.set(sourceId, record);
    corrected.set(sourceId, row);
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) fail("INVALID_CLOCK");
  const blocked = new Map<string, string[]>();
  for (const entry of validated.entries) {
    const reasons: string[] = [];
    const source = validated.sources.get(entry.revisionId)!;
    if (entry.decision === "blocked") reasons.push("AUDIT_ENTRY_BLOCKED");
    if (entry.decision === "revise") {
      if (
        !entry.sourceChecks.some(
          (check) =>
            check.url === entry.payload.sourceUrl &&
            check.result === "verified" &&
            check.evidence.trim(),
        )
      )
        reasons.push("VERIFIED_SOURCES_REQUIRED");
      if (
        entry.sourceChecks.some((check) => new Date(check.checkedAt) > now) ||
        new Date(entry.payload.sourceCheckedAt) > now
      )
        reasons.push("SOURCE_CHECKED_AT_FUTURE");
      if (!["draft", "published"].includes(source.lifecycle_status))
        reasons.push("SOURCE_STATUS_NOT_EDITABLE");
      if (source.missingTimeSensitive)
        reasons.push("BASELINE_TIME_SENSITIVE_MISSING");
      if (
        source.lifecycle_status === "published" &&
        entry.payload.timeSensitive &&
        (entry.payload.validUntil === null ||
          new Date(entry.payload.validUntil) <= now)
      )
        reasons.push("REVISION_VALIDITY_EXPIRED");
    }
    if (reasons.length) blocked.set(entry.revisionId, reasons);
    if (mappings.has(entry.revisionId) && reasons.length)
      fail("MAPPED_CORRECTION_NO_LONGER_ELIGIBLE");
  }
  return { ...validated, mappings, corrected, blocked, batch, contentHash };
}
async function loadSets(
  transaction: Transaction,
  state: Prepared,
): Promise<SetRow[]> {
  const ids = [
    ...state.entries
      .filter((entry) => entry.decision !== "keep")
      .map((entry) => entry.revisionId),
    ...[...state.corrected.values()].map((row) => row.id),
  ];
  const mappings = await transaction<{ resource_id: string }[]>`
    SELECT resource_id FROM admin_audit_logs
    WHERE action = ${SET_ACTION} AND metadata->>'batch' = ${state.batch}
  `;
  if (!ids.length && !mappings.length) return [];
  const rows = await transaction<SetRow[]>`
    SELECT ds.id, ds.quiz_date::text, ds.version::int, ds.status::text,
      EXISTS (SELECT 1 FROM attempts WHERE daily_set_id = ds.id) AS has_attempts,
      EXISTS (SELECT 1 FROM challenges WHERE daily_set_id = ds.id) AS has_challenges,
      EXISTS (SELECT 1 FROM daily_set_voids WHERE daily_set_id = ds.id) AS is_void
    FROM daily_sets ds WHERE ${
      ids.length
        ? transaction`EXISTS (
      SELECT 1 FROM daily_set_items WHERE daily_set_id = ds.id AND question_revision_id IN ${transaction(ids)}
    )`
        : transaction`false`
    } OR EXISTS (
      SELECT 1 FROM admin_audit_logs WHERE action = ${SET_ACTION}
        AND resource_id = ds.id AND metadata->>'batch' = ${state.batch}
    ) ORDER BY ds.quiz_date, ds.id
  `;
  if (
    mappings.some(
      (mapping) => !rows.some((row) => row.id === mapping.resource_id),
    )
  )
    fail("SET_REPLAY_DRIFT");
  for (const row of rows) {
    row.items = await transaction<SetItem[]>`
      SELECT dsi.position::int, qr.id AS revision_id, qr.question_id, dsi.choice_order,
        qr.category, qr.difficulty::text, qr.lifecycle_status::text, qr.time_sensitive, qr.valid_until
      FROM daily_set_items dsi JOIN question_revisions qr ON qr.id = dsi.question_revision_id
      WHERE dsi.daily_set_id = ${row.id} ORDER BY dsi.position
    `;
  }
  return rows;
}
function entryForItem(state: Prepared, item: SetItem): Entry | undefined {
  return state.entries.find(
    (entry) =>
      entry.revisionId === item.revision_id ||
      state.corrected.get(entry.revisionId)?.id === item.revision_id,
  );
}
async function planSet(
  transaction: Transaction,
  state: Prepared,
  set: SetRow,
  now: Date,
): Promise<ContentCorrectionsReceipt["sets"][number]> {
  const records = await transaction<MappingRow[]>`
    SELECT id, resource_id, metadata FROM admin_audit_logs WHERE action = ${SET_ACTION}
      AND resource_id = ${set.id} AND metadata->>'batch' = ${state.batch}
  `;
  const items = set.items.map((item) => {
    const entry = entryForItem(state, item);
    const replacement =
      entry?.decision === "revise" && !state.blocked.has(entry.revisionId);
    return {
      position: item.position,
      questionId: item.question_id,
      fromRevisionId: item.revision_id,
      toRevisionId: replacement
        ? (state.corrected.get(entry!.revisionId)?.id ?? null)
        : item.revision_id,
      choiceOrder: item.choice_order,
    };
  });
  const result: ContentCorrectionsReceipt["sets"][number] = {
    dailySetId: set.id,
    quizDate: set.quiz_date,
    expectedVersion: set.version,
    resultVersion: null,
    status: "planned",
    blockedReasons: [],
    items,
  };
  if (records.length) {
    const metadata = records[0]!.metadata;
    const exactItems = items.map((item) => ({
      position: item.position,
      questionId: item.questionId,
      revisionId: item.fromRevisionId,
      choiceOrder: item.choiceOrder,
    }));
    if (
      records.length !== 1 ||
      metadata.contentHash !== state.contentHash ||
      metadata.version !== set.version ||
      stable(metadata.items) !== stable(exactItems)
    ) {
      result.status = "blocked";
      result.blockedReasons.push("SET_REPLAY_DRIFT");
    } else {
      result.status = "already_corrected";
      result.expectedVersion = Number(metadata.previousVersion);
      result.resultVersion = set.version;
    }
    return result;
  }
  const clocks = await transaction<
    { today: string }[]
  >`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date::text AS today`;
  const today = [clocks[0]!.today, getKstDate(now)].sort()[1]!;
  if (set.quiz_date <= today) {
    result.status = "historical_set_unchanged";
    return result;
  }
  if (set.status !== "published") {
    result.status = "nonpublished_set_unchanged";
    return result;
  }
  if (set.has_attempts) result.blockedReasons.push("DAILY_SET_HAS_ATTEMPTS");
  if (set.has_challenges)
    result.blockedReasons.push("DAILY_SET_HAS_CHALLENGES");
  if (set.is_void) result.blockedReasons.push("DAILY_SET_VOIDED");
  if (
    set.items.length !== 5 ||
    set.items.some(
      (item, index) =>
        item.position !== index + 1 ||
        !ChoiceOrderSchema.safeParse(item.choice_order).success,
    ) ||
    new Set(set.items.map((item) => item.question_id)).size !== 5
  )
    result.blockedReasons.push("DAILY_SET_ITEM_INTEGRITY_INVALID");
  const difficulty = { easy: 0, medium: 0, hard: 0 };
  const categories = new Map<string, number>();
  let replacementCount = 0;
  for (const item of set.items) {
    const entry = entryForItem(state, item);
    if (entry && state.blocked.has(entry.revisionId))
      result.blockedReasons.push(...state.blocked.get(entry.revisionId)!);
    const revised =
      entry?.decision === "revise" && !state.blocked.has(entry.revisionId);
    const request = revised ? entry!.payload : undefined;
    if (revised) replacementCount++;
    const category = request?.category ?? item.category;
    const level = request?.difficulty ?? item.difficulty;
    difficulty[level]++;
    categories.set(category, (categories.get(category) ?? 0) + 1);
    if (
      (request
        ? state.sources.get(entry!.revisionId)!.lifecycle_status
        : item.lifecycle_status) !== "published"
    )
      result.blockedReasons.push("DAILY_SET_REVISION_NOT_PUBLISHED");
    const timeSensitive = request?.timeSensitive ?? item.time_sensitive;
    const validUntil = request ? request.validUntil : item.valid_until;
    if (
      timeSensitive &&
      (validUntil === null ||
        new Date(validUntil) <= new Date(`${set.quiz_date}T16:00:00.000Z`))
    )
      result.blockedReasons.push("DAILY_SET_REVISION_VALIDITY_EXPIRED");
  }
  if (
    difficulty.easy !== 2 ||
    (difficulty.hard !== 0 && difficulty.hard !== 1) ||
    difficulty.medium !== 3 - difficulty.hard
  )
    result.blockedReasons.push("DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID");
  if ([...categories.values()].some((count) => count > 2))
    result.blockedReasons.push("DAILY_SET_CATEGORY_LIMIT_EXCEEDED");
  const recent = await transaction`
    SELECT 1 FROM daily_sets ds JOIN daily_set_items dsi ON dsi.daily_set_id = ds.id
    JOIN question_revisions qr ON qr.id = dsi.question_revision_id
    WHERE ds.status = 'published' AND ds.id <> ${set.id}
      AND ds.quiz_date BETWEEN ${set.quiz_date}::date - 14 AND ${set.quiz_date}::date + 14
      AND qr.question_id IN ${transaction(set.items.map((item) => item.question_id))} LIMIT 1
  `;
  if (recent.length)
    result.blockedReasons.push("DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED");
  if (!replacementCount) result.blockedReasons.push("NO_ELIGIBLE_CORRECTIONS");
  result.blockedReasons = [...new Set(result.blockedReasons)];
  if (result.blockedReasons.length) result.status = "blocked";
  return result;
}
function receipt(
  state: Prepared,
  apply: boolean,
  sets: ContentCorrectionsReceipt["sets"],
  created: Set<string>,
): ContentCorrectionsReceipt {
  return {
    batch: state.batch,
    contentHash: state.contentHash,
    mode: apply ? "apply" : "preview",
    status: !apply
      ? "preview"
      : state.blocked.size || sets.some((set) => set.status === "blocked")
        ? "partial"
        : "applied",
    created: created.size,
    existing: state.mappings.size - created.size,
    warnings: state.warnings,
    items: state.entries.map((entry) => ({
      sourceRevisionId: entry.revisionId,
      questionId: entry.questionId,
      decision: entry.decision,
      correctedRevisionId: state.corrected.get(entry.revisionId)?.id ?? null,
      targetStatus:
        entry.decision === "revise"
          ? state.sources.get(entry.revisionId)!.lifecycle_status ===
            "published"
            ? "published"
            : "draft"
          : null,
      status:
        entry.decision === "keep"
          ? "keep"
          : state.blocked.has(entry.revisionId)
            ? "blocked"
            : state.mappings.has(entry.revisionId)
              ? created.has(entry.revisionId)
                ? "created"
                : "existing"
              : "planned",
      blockedReasons: state.blocked.get(entry.revisionId) ?? [],
      historicalSetUnchanged: sets.some(
        (set) =>
          set.status === "historical_set_unchanged" &&
          set.items.some((item) => item.questionId === entry.questionId),
      ),
    })),
    sets,
  };
}
function sanitizedCode(error: unknown): string {
  if (error instanceof CorrectionError) return error.code;
  if (error instanceof AppError && /^DAILY_SET_[A-Z_]+$/.test(error.code))
    return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "42501"
  )
    return "CORRECTION_PRIVILEGES_REQUIRED";
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "42883"
  )
    return "CORRECTION_SERVICE_UNAVAILABLE";
  return "CONTENT_CORRECTIONS_FAILED";
}
async function execute(
  database: Database,
  input: unknown,
  baseline: unknown,
  actor: string,
  apply: boolean,
  options: ContentCorrectionsOptions,
): Promise<ContentCorrectionsReceipt> {
  try {
    // Structural validation precedes even the first transaction, including all identities.
    validate(input, baseline, actor, options.expectedCount ?? 165);
    const now = options.now ?? new Date();
    const created = new Set<string>();
    const initial = await database.client.begin(
      "read only",
      async (transaction) => {
        const state = await prepare(
          transaction,
          input,
          baseline,
          actor,
          options,
          false,
        );
        const sets = await loadSets(transaction, state);
        const plans = [];
        for (const set of sets)
          plans.push(await planSet(transaction, state, set, now));
        return { state, plans };
      },
    );
    if (!apply) return receipt(initial.state, false, initial.plans, created);
    // All source/mapping checks happen again under locks before the first write.
    const state = await database.client.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(1378035794)`;
      await transaction`SELECT pg_advisory_xact_lock(1835627636, 166)`;
      const prepared = await prepare(
        transaction,
        input,
        baseline,
        actor,
        options,
        true,
      );
      const serviceDatabase = scoped(database, transaction);
      for (const entry of prepared.entries) {
        if (
          entry.decision !== "revise" ||
          prepared.blocked.has(entry.revisionId)
        )
          continue;
        let mapping = prepared.mappings.get(entry.revisionId);
        let row = prepared.corrected.get(entry.revisionId);
        const targetStatus =
          prepared.sources.get(entry.revisionId)!.lifecycle_status ===
          "published"
            ? "published"
            : "draft";
        if (!mapping) {
          const revision = await createQuestionRevision(
            serviceDatabase,
            actor,
            entry.payload,
          );
          const metadata = {
            batch: prepared.batch,
            contentHash: prepared.contentHash,
            sourceRevisionId: entry.revisionId,
            questionId: entry.questionId,
            payloadHash: hash(canonical(entry.payload)),
            revisionNumber: revision.revisionNumber,
            targetStatus,
            stage: "created",
          };
          const rows = await transaction<MappingRow[]>`
            INSERT INTO admin_audit_logs (actor_subject, action, resource_type, resource_id, metadata)
            VALUES (${actor}, ${REVISION_ACTION}, 'question_revision', ${revision.revisionId}, ${JSON.stringify(metadata)}::jsonb)
            RETURNING id, resource_id, metadata
          `;
          mapping = rows[0]!;
          row = {
            id: revision.revisionId,
            question_id: revision.questionId,
            revision_number: revision.revisionNumber,
            lifecycle_status: "draft",
            request: entry.payload,
            published_at: null,
            retired_at: null,
          };
          prepared.mappings.set(entry.revisionId, mapping);
          prepared.corrected.set(entry.revisionId, row);
          created.add(entry.revisionId);
        }
        if (mapping.metadata.stage === "ready") continue;
        if (targetStatus === "published") {
          const stages = ["draft", "review", "approved", "published"] as const;
          const current = stages.indexOf(
            row!.lifecycle_status as (typeof stages)[number],
          );
          for (const status of stages.slice(current + 1))
            await updateQuestionRevisionStatus(
              serviceDatabase,
              actor,
              row!.id,
              status,
              now,
            );
          row!.lifecycle_status = "published";
          row!.published_at = now;
        }
        await transaction`UPDATE admin_audit_logs SET metadata = metadata || '{"stage":"ready"}'::jsonb WHERE id = ${mapping.id}`;
        mapping.metadata.stage = "ready";
      }
      return prepared;
    });
    // Revision creation/mapping/publication is atomic. Set corrections are separately
    // atomic so one newly played, expired, or composition-invalid set cannot hide others.
    const sets = await database.client.begin("read only", (transaction) =>
      loadSets(transaction, state),
    );
    const plans: ContentCorrectionsReceipt["sets"] = [];
    for (const candidate of sets) {
      let observed: ContentCorrectionsReceipt["sets"][number] | undefined;
      try {
        const result = await database.client.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(1378035794)`;
          await transaction`SELECT pg_advisory_xact_lock(1835627636, 166)`;
          // Revalidate immutable source and mapped payloads before each correction.
          const checked = await prepare(
            transaction,
            input,
            baseline,
            actor,
            options,
            true,
          );
          const current = (await loadSets(transaction, checked)).find(
            (set) => set.id === candidate.id,
          );
          if (!current) fail("SET_SOURCE_REFERENCE_CHANGED");
          const plan = await planSet(transaction, checked, current, now);
          observed = plan;
          if (plan.status !== "planned") return plan;
          const result = await correctFutureDailySet(
            scoped(database, transaction),
            actor,
            current.id,
            {
              expectedVersion: current.version,
              reason: `Editorial corrections ${state.contentHash}`,
              items: plan.items.map((item) => ({
                revisionId: item.toRevisionId!,
                choiceOrder: item.choiceOrder,
              })),
            },
            now,
          );
          const metadata = {
            batch: state.batch,
            contentHash: state.contentHash,
            previousVersion: current.version,
            version: result.version,
            items: plan.items.map((item) => ({
              position: item.position,
              questionId: item.questionId,
              revisionId: item.toRevisionId,
              choiceOrder: item.choiceOrder,
            })),
          };
          await transaction`
            INSERT INTO admin_audit_logs (actor_subject, action, resource_type, resource_id, metadata)
            VALUES (${actor}, ${SET_ACTION}, 'daily_set', ${current.id}, ${JSON.stringify(metadata)}::jsonb)
          `;
          return {
            ...plan,
            status: "corrected" as const,
            resultVersion: result.version,
          };
        });
        plans.push(result);
      } catch (error) {
        plans.push({
          ...(observed ?? {
            dailySetId: candidate.id,
            quizDate: candidate.quiz_date,
            expectedVersion: candidate.version,
            resultVersion: null,
            items: [],
          }),
          status: "blocked",
          blockedReasons: [sanitizedCode(error)],
        });
      }
    }
    return receipt(state, true, plans, created);
  } catch (error) {
    throw new CorrectionError(sanitizedCode(error));
  }
}
export function previewContentCorrections(
  database: Database,
  input: unknown,
  baseline: unknown,
  actor: string,
  options: ContentCorrectionsOptions = {},
): Promise<ContentCorrectionsReceipt> {
  return execute(database, input, baseline, actor, false, options);
}
export function applyContentCorrections(
  database: Database,
  input: unknown,
  baseline: unknown,
  actor: string,
  options: ContentCorrectionsOptions = {},
): Promise<ContentCorrectionsReceipt> {
  return execute(database, input, baseline, actor, true, options);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      baseline: { type: "string" },
      "url-file": { type: "string" },
      "ca-file": { type: "string" },
      "receipt-file": { type: "string" },
      actor: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (
    !values.input ||
    !values.baseline ||
    !values["url-file"] ||
    !values["receipt-file"] ||
    !values.actor
  )
    fail("REQUIRED_ARGUMENTS_MISSING");
  const output = await open(values["receipt-file"], "wx", 0o600);
  let client: SqlClient | undefined;
  try {
    const input: unknown = JSON.parse(await readFile(values.input, "utf8"));
    const baseline: unknown = JSON.parse(
      await readFile(values.baseline, "utf8"),
    );
    validate(input, baseline, values.actor, 165);
    const rawUrl = (await readFile(values["url-file"], "utf8")).trim();
    const url = new URL(rawUrl);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.hash
    )
      fail("INVALID_DATABASE_URL");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      !local &&
      (url.searchParams.getAll("sslmode").length !== 1 ||
        url.searchParams.get("sslmode") !== "verify-full" ||
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
        !values["ca-file"])
    )
      fail("VERIFIED_DATABASE_TLS_REQUIRED");
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
        fail("DATABASE_CONNECTION_OVERRIDE_REJECTED");
    }
    const ca = values["ca-file"]
      ? await readFile(values["ca-file"], "utf8")
      : undefined;
    if (!local && (!ca || !ca.includes("-----BEGIN CERTIFICATE-----")))
      fail("DATABASE_CA_REQUIRED");
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
      onnotice: () => undefined,
      ssl: !local || ca ? { ca, rejectUnauthorized: true } : undefined,
    });
    const { drizzle } = require("drizzle-orm/postgres-js") as {
      drizzle(sql: SqlClient): Database["orm"];
    };
    const database: Database = {
      client,
      orm: drizzle(client),
      close: () => client!.end({ timeout: 5 }),
    };
    const result = await execute(
      database,
      input,
      baseline,
      values.actor,
      values.apply,
      {},
    );
    await output.writeFile(`${JSON.stringify(result, null, 2)}\n`);
    console.log(
      JSON.stringify({
        mode: result.mode,
        status: result.status,
        created: result.created,
        existing: result.existing,
        blockedItems: result.items.filter((item) => item.status === "blocked")
          .length,
        blockedSets: result.sets.filter((set) => set.status === "blocked")
          .length,
      }),
    );
    if (values.apply && result.status !== "applied") process.exitCode = 1;
  } catch (error) {
    await output.writeFile(
      `${JSON.stringify({ mode: values.apply ? "apply" : "preview", status: "failed", code: sanitizedCode(error), note: "Database stages may already be committed. Resume with the identical input and baseline, using a new receipt filename." }, null, 2)}\n`,
    );
    throw new CorrectionError(sanitizedCode(error));
  } finally {
    await output.close();
    await client?.end({ timeout: 5 });
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    console.error(
      `Content corrections failed: ${sanitizedCode(error)}. No connection details or database errors are included.`,
    );
    process.exitCode = 1;
  });
}
