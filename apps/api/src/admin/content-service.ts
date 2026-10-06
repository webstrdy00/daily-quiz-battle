import {
  AdminCreateDailySetDraftResponseSchema,
  AdminCreateQuestionRevisionResponseSchema,
  AdminListAuditLogsResponseSchema,
  AdminListDailySetsResponseSchema,
  AdminListQuestionRevisionsResponseSchema,
  AdminPublishDailySetResponseSchema,
  AdminUpdateQuestionRevisionStatusResponseSchema,
  IsoDateTimeSchema,
  UuidSchema,
  type AdminAuditAction,
  type AdminAuditResourceType,
  type AdminCreateDailySetDraftRequest,
  type AdminCreateDailySetDraftResponse,
  type AdminCreateQuestionRevisionRequest,
  type AdminCreateQuestionRevisionResponse,
  type AdminListAuditLogsQuery,
  type AdminListAuditLogsResponse,
  type AdminListDailySetsQuery,
  type AdminListDailySetsResponse,
  type AdminListQuestionRevisionsQuery,
  type AdminListQuestionRevisionsResponse,
  type AdminPublishDailySetResponse,
  type AdminUpdateQuestionRevisionStatusResponse,
  type ContentStatus,
  type DailySetStatus,
} from "@daily-quiz-battle/contracts";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";

type Transaction = TransactionSql<{}>;

interface QuestionRevisionRow {
  id: string;
  question_id: string;
  revision_number: number;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  lifecycle_status: ContentStatus;
  source_checked_at: Date | string;
  time_sensitive: boolean;
  valid_until: Date | string | null;
  published_at: Date | string | null;
  retired_at: Date | string | null;
  created_at: Date | string;
}

interface DailySetRow {
  id: string;
  quiz_date: string;
  version: number;
  status: DailySetStatus;
  published_at: Date | string | null;
}

interface DailySetItemRow {
  position: number;
  question_revision_id: string;
}

interface QuestionRevisionListRow extends QuestionRevisionRow {
  prompt: string;
  choices: unknown;
  correct_index: number;
  explanation: string;
  source_url: string;
  reviewer_id: string;
  next_review_at: Date | string | null;
}

interface DailySetListRow extends DailySetRow {
  created_at: Date | string;
  void_actor_subject: string | null;
  void_reason: string | null;
  voided_at: Date | string | null;
}

interface DailySetListItemRow {
  daily_set_id: string;
  position: number;
  choice_order: unknown;
  revision_id: string;
  question_id: string;
  revision_number: number;
  prompt: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  lifecycle_status: ContentStatus;
}

interface AuditLogListRow {
  id: string;
  actor_subject: string;
  action: AdminAuditAction;
  resource_type: AdminAuditResourceType;
  resource_id: string;
  metadata: unknown;
  created_at: Date | string;
}

const PaginationCursorPayloadSchema = z
  .object({
    createdAt: IsoDateTimeSchema,
    id: UuidSchema,
  })
  .strict();

type PaginationCursorPayload = z.infer<typeof PaginationCursorPayloadSchema>;

const LEGAL_STATUS_TRANSITIONS: Record<
  ContentStatus,
  readonly ContentStatus[]
> = {
  draft: ["draft", "review"],
  review: ["review", "draft", "approved"],
  approved: ["approved", "draft", "published"],
  published: ["published", "retired"],
  retired: ["retired"],
};

function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      statusCode: 500,
      code: "CONTENT_DATA_INTEGRITY_ERROR",
      message: "콘텐츠 변경 결과를 불러오지 못했습니다.",
    });
  }
  return date.toISOString();
}

function toNullableIsoDateTime(value: Date | string | null): string | null {
  return value === null ? null : toIsoDateTime(value);
}

function revisionNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: "QUESTION_REVISION_NOT_FOUND",
    message: "문제 리비전을 찾을 수 없습니다.",
  });
}

function encodePaginationCursor(row: {
  id: string;
  created_at: Date | string;
}): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: toIsoDateTime(row.created_at),
      id: row.id,
    }),
  ).toString("base64url");
}

function decodePaginationCursor(
  cursor: string | undefined,
): PaginationCursorPayload | null {
  if (cursor === undefined) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    const parsed = PaginationCursorPayloadSchema.safeParse(payload);
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // The caller receives the same query-validation response for every
    // malformed opaque cursor.
  }

  throw new AppError({
    statusCode: 400,
    code: "INVALID_REQUEST",
    message: "요청 형식이 올바르지 않습니다.",
    details: {
      fields: [{ path: "cursor", code: "invalid_format" }],
    },
  });
}

async function insertAuditLog(
  transaction: Transaction,
  actorSubject: string,
  action: AdminAuditAction,
  resourceType: AdminAuditResourceType,
  resourceId: string,
  metadata: Record<string, string>,
): Promise<void> {
  await transaction`
    INSERT INTO admin_audit_logs (
      actor_subject,
      action,
      resource_type,
      resource_id,
      metadata
    )
    VALUES (
      ${actorSubject},
      ${action},
      ${resourceType},
      ${resourceId},
      ${JSON.stringify(metadata)}::jsonb
    )
  `;
}

export async function listQuestionRevisions(
  database: Database,
  query: AdminListQuestionRevisionsQuery,
): Promise<AdminListQuestionRevisionsResponse> {
  const cursor = decodePaginationCursor(query.cursor);
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const status = query.status ?? null;
  const rows = await database.client<QuestionRevisionListRow[]>`
    SELECT
      id,
      question_id,
      revision_number::int AS revision_number,
      prompt,
      choices,
      correct_index::int AS correct_index,
      explanation,
      source_url,
      source_checked_at,
      category,
      difficulty::text AS difficulty,
      lifecycle_status::text AS lifecycle_status,
      reviewer_id,
      time_sensitive,
      valid_until,
      next_review_at,
      published_at,
      retired_at,
      created_at
    FROM question_revisions
    WHERE (
      ${status}::content_status IS NULL
      OR lifecycle_status = ${status}::content_status
    )
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (
          ${cursorCreatedAt}::timestamptz,
          ${cursorId}::uuid
        )
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${query.limit + 1}
  `;
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const lastRow = page.at(-1);

  return AdminListQuestionRevisionsResponseSchema.parse({
    questionRevisions: page.map((row) => ({
      revisionId: row.id,
      questionId: row.question_id,
      revisionNumber: row.revision_number,
      prompt: row.prompt,
      choices: row.choices,
      correctIndex: row.correct_index,
      explanation: row.explanation,
      sourceUrl: row.source_url,
      sourceCheckedAt: toIsoDateTime(row.source_checked_at),
      category: row.category,
      difficulty: row.difficulty,
      status: row.lifecycle_status,
      reviewerId: row.reviewer_id,
      timeSensitive: row.time_sensitive,
      validUntil: toNullableIsoDateTime(row.valid_until),
      nextReviewAt: toNullableIsoDateTime(row.next_review_at),
      publishedAt: toNullableIsoDateTime(row.published_at),
      retiredAt: toNullableIsoDateTime(row.retired_at),
      createdAt: toIsoDateTime(row.created_at),
    })),
    nextCursor:
      hasNextPage && lastRow !== undefined
        ? encodePaginationCursor(lastRow)
        : null,
  });
}

export async function listDailySets(
  database: Database,
  query: AdminListDailySetsQuery,
): Promise<AdminListDailySetsResponse> {
  const status = query.status ?? null;
  const dailySets = await database.client<DailySetListRow[]>`
    SELECT
      ds.id,
      ds.quiz_date::text AS quiz_date,
      ds.version::int AS version,
      ds.status::text AS status,
      ds.published_at,
      ds.created_at,
      dsv.actor_subject AS void_actor_subject,
      dsv.reason AS void_reason,
      dsv.voided_at
    FROM daily_sets ds
    LEFT JOIN daily_set_voids dsv ON dsv.daily_set_id = ds.id
    WHERE ds.quiz_date BETWEEN ${query.from}::date AND ${query.to}::date
      AND (
        ${status}::daily_set_status IS NULL
        OR ds.status = ${status}::daily_set_status
      )
    ORDER BY ds.quiz_date DESC, ds.id DESC
  `;

  if (dailySets.length === 0) {
    return AdminListDailySetsResponseSchema.parse({ dailySets: [] });
  }

  const dailySetIds = dailySets.map((dailySet) => dailySet.id);
  const itemRows = await database.client<DailySetListItemRow[]>`
    SELECT
      dsi.daily_set_id,
      dsi.position::int AS position,
      dsi.choice_order,
      qr.id AS revision_id,
      qr.question_id,
      qr.revision_number::int AS revision_number,
      qr.prompt,
      qr.category,
      qr.difficulty::text AS difficulty,
      qr.lifecycle_status::text AS lifecycle_status
    FROM daily_set_items dsi
    JOIN question_revisions qr ON qr.id = dsi.question_revision_id
    WHERE dsi.daily_set_id IN ${database.client(dailySetIds)}
    ORDER BY dsi.daily_set_id, dsi.position
  `;
  const itemsByDailySetId = new Map<
    string,
    Array<{
      position: number;
      choiceOrder: unknown;
      revision: {
        revisionId: string;
        questionId: string;
        revisionNumber: number;
        prompt: string;
        category: string;
        difficulty: "easy" | "medium" | "hard";
        status: ContentStatus;
      };
    }>
  >();
  for (const row of itemRows) {
    const items = itemsByDailySetId.get(row.daily_set_id) ?? [];
    items.push({
      position: row.position,
      choiceOrder: row.choice_order,
      revision: {
        revisionId: row.revision_id,
        questionId: row.question_id,
        revisionNumber: row.revision_number,
        prompt: row.prompt,
        category: row.category,
        difficulty: row.difficulty,
        status: row.lifecycle_status,
      },
    });
    itemsByDailySetId.set(row.daily_set_id, items);
  }

  return AdminListDailySetsResponseSchema.parse({
    dailySets: dailySets.map((dailySet) => ({
      dailySetId: dailySet.id,
      quizDate: dailySet.quiz_date,
      version: dailySet.version,
      status: dailySet.status,
      publishedAt: toNullableIsoDateTime(dailySet.published_at),
      createdAt: toIsoDateTime(dailySet.created_at),
      void:
        dailySet.voided_at === null
          ? null
          : {
              actorSubject: dailySet.void_actor_subject,
              reason: dailySet.void_reason,
              voidedAt: toIsoDateTime(dailySet.voided_at),
            },
      items: itemsByDailySetId.get(dailySet.id) ?? [],
    })),
  });
}

export async function listAuditLogs(
  database: Database,
  query: AdminListAuditLogsQuery,
): Promise<AdminListAuditLogsResponse> {
  const cursor = decodePaginationCursor(query.cursor);
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const rows = await database.client<AuditLogListRow[]>`
    SELECT
      id,
      actor_subject,
      action,
      resource_type,
      resource_id,
      metadata,
      created_at
    FROM admin_audit_logs
    WHERE (
      ${cursorCreatedAt}::timestamptz IS NULL
      OR (created_at, id) < (
        ${cursorCreatedAt}::timestamptz,
        ${cursorId}::uuid
      )
    )
    ORDER BY created_at DESC, id DESC
    LIMIT ${query.limit + 1}
  `;
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const lastRow = page.at(-1);

  return AdminListAuditLogsResponseSchema.parse({
    auditLogs: page.map((row) => ({
      actorSubject: row.actor_subject,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: row.metadata,
      createdAt: toIsoDateTime(row.created_at),
    })),
    nextCursor:
      hasNextPage && lastRow !== undefined
        ? encodePaginationCursor(lastRow)
        : null,
  });
}

export async function createQuestionRevision(
  database: Database,
  actorSubject: string,
  request: AdminCreateQuestionRevisionRequest,
): Promise<AdminCreateQuestionRevisionResponse> {
  return database.client.begin(async (transaction) => {
    let questionId = request.questionId;
    let revisionNumber = 1;

    if (questionId === undefined) {
      const questions = await transaction<{ id: string }[]>`
        INSERT INTO questions DEFAULT VALUES
        RETURNING id
      `;
      questionId = questions[0]?.id;
      if (questionId === undefined) {
        throw new AppError({
          statusCode: 500,
          code: "QUESTION_CREATE_FAILED",
          message: "문제를 생성하지 못했습니다.",
        });
      }
    } else {
      const questions = await transaction<{ id: string }[]>`
        SELECT id
        FROM questions
        WHERE id = ${questionId}
        FOR UPDATE
      `;
      if (questions[0] === undefined) {
        throw new AppError({
          statusCode: 404,
          code: "QUESTION_NOT_FOUND",
          message: "문제를 찾을 수 없습니다.",
        });
      }

      const revisionNumbers = await transaction<{ revision_number: number }[]>`
        SELECT (coalesce(max(revision_number), 0) + 1)::int AS revision_number
        FROM question_revisions
        WHERE question_id = ${questionId}
      `;
      revisionNumber = revisionNumbers[0]?.revision_number ?? 1;
    }

    const revisions = await transaction<QuestionRevisionRow[]>`
      INSERT INTO question_revisions (
        question_id,
        revision_number,
        category,
        difficulty,
        prompt,
        choices,
        correct_index,
        explanation,
        source_url,
        source_checked_at,
        reviewer_id,
        time_sensitive,
        valid_until,
        next_review_at,
        lifecycle_status
      )
      VALUES (
        ${questionId},
        ${revisionNumber},
        ${request.category},
        ${request.difficulty},
        ${request.prompt},
        ${JSON.stringify(request.choices)}::jsonb,
        ${request.correctIndex},
        ${request.explanation},
        ${request.sourceUrl},
        ${request.sourceCheckedAt},
        ${request.reviewerId},
        ${request.timeSensitive},
        ${request.validUntil},
        ${request.nextReviewAt},
        'draft'
      )
      RETURNING
        id,
        question_id,
        revision_number::int AS revision_number,
        category,
        difficulty::text AS difficulty,
        lifecycle_status::text AS lifecycle_status,
        source_checked_at,
        time_sensitive,
        valid_until,
        published_at,
        retired_at,
        created_at
    `;
    const revision = revisions[0];
    if (revision === undefined) {
      throw new AppError({
        statusCode: 500,
        code: "QUESTION_REVISION_CREATE_FAILED",
        message: "문제 리비전을 생성하지 못했습니다.",
      });
    }

    const action = "question_revision.create";
    await insertAuditLog(
      transaction,
      actorSubject,
      action,
      "question_revision",
      revision.id,
      {
        action,
        status: "draft",
        category: revision.category,
        difficulty: revision.difficulty,
      },
    );

    return AdminCreateQuestionRevisionResponseSchema.parse({
      questionId: revision.question_id,
      revisionId: revision.id,
      revisionNumber: revision.revision_number,
      status: "draft",
      createdAt: toIsoDateTime(revision.created_at),
    });
  });
}

export async function updateQuestionRevisionStatus(
  database: Database,
  actorSubject: string,
  revisionId: string,
  status: ContentStatus,
  now = new Date(),
): Promise<AdminUpdateQuestionRevisionStatusResponse> {
  return database.client.begin(async (transaction) => {
    const revisions = await transaction<QuestionRevisionRow[]>`
      SELECT
        id,
        question_id,
        revision_number::int AS revision_number,
        category,
        difficulty::text AS difficulty,
        lifecycle_status::text AS lifecycle_status,
        source_checked_at,
        time_sensitive,
        valid_until,
        published_at,
        retired_at,
        created_at
      FROM question_revisions
      WHERE id = ${revisionId}
      FOR UPDATE
    `;
    const revision = revisions[0];
    if (revision === undefined) {
      throw revisionNotFound();
    }

    if (!LEGAL_STATUS_TRANSITIONS[revision.lifecycle_status].includes(status)) {
      throw new AppError({
        statusCode: 409,
        code: "QUESTION_REVISION_STATUS_TRANSITION_INVALID",
        message: "허용되지 않는 문제 리비전 상태 변경입니다.",
        details: { from: revision.lifecycle_status, to: status },
      });
    }

    if (status === "published" && revision.lifecycle_status !== "published") {
      const sourceCheckedAt = new Date(revision.source_checked_at);
      if (sourceCheckedAt > now) {
        throw new AppError({
          statusCode: 422,
          code: "QUESTION_REVISION_SOURCE_CHECKED_AT_FUTURE",
          message: "출처 확인 시각은 미래일 수 없습니다.",
        });
      }
      if (
        revision.time_sensitive &&
        (revision.valid_until === null || new Date(revision.valid_until) <= now)
      ) {
        throw new AppError({
          statusCode: 422,
          code: "QUESTION_REVISION_VALIDITY_EXPIRED",
          message: "시의성 문제의 유효기간이 지났습니다.",
        });
      }
    }

    const publishedAt =
      status === "published" && revision.lifecycle_status !== "published"
        ? now
        : revision.published_at;
    const retiredAt =
      status === "retired" && revision.lifecycle_status !== "retired"
        ? now
        : revision.retired_at;

    const updatedRows = await transaction<QuestionRevisionRow[]>`
      UPDATE question_revisions
      SET
        lifecycle_status = ${status},
        published_at = ${
          publishedAt instanceof Date ? publishedAt.toISOString() : publishedAt
        },
        retired_at = ${
          retiredAt instanceof Date ? retiredAt.toISOString() : retiredAt
        }
      WHERE id = ${revisionId}
      RETURNING
        id,
        question_id,
        revision_number::int AS revision_number,
        category,
        difficulty::text AS difficulty,
        lifecycle_status::text AS lifecycle_status,
        source_checked_at,
        time_sensitive,
        valid_until,
        published_at,
        retired_at,
        created_at
    `;
    const updated = updatedRows[0];
    if (updated === undefined) {
      throw revisionNotFound();
    }

    const action = "question_revision.status.update";
    await insertAuditLog(
      transaction,
      actorSubject,
      action,
      "question_revision",
      revisionId,
      {
        action,
        status,
        category: updated.category,
        difficulty: updated.difficulty,
      },
    );

    return AdminUpdateQuestionRevisionStatusResponseSchema.parse({
      revisionId: updated.id,
      status: updated.lifecycle_status,
      publishedAt: toNullableIsoDateTime(updated.published_at),
      retiredAt: toNullableIsoDateTime(updated.retired_at),
    });
  });
}

export async function createDailySetDraft(
  database: Database,
  actorSubject: string,
  request: AdminCreateDailySetDraftRequest,
): Promise<AdminCreateDailySetDraftResponse> {
  const revisionIds = request.items.map((item) => item.revisionId);
  if (new Set(revisionIds).size !== 5) {
    throw new AppError({
      statusCode: 422,
      code: "DAILY_SET_REVISIONS_NOT_DISTINCT",
      message: "서로 다른 문제 리비전 5개가 필요합니다.",
    });
  }

  return database.client.begin(async (transaction) => {
    const revisions = await transaction<QuestionRevisionRow[]>`
      SELECT
        id,
        question_id,
        revision_number::int AS revision_number,
        category,
        difficulty::text AS difficulty,
        lifecycle_status::text AS lifecycle_status,
        source_checked_at,
        time_sensitive,
        valid_until,
        published_at,
        retired_at,
        created_at
      FROM question_revisions
      WHERE id IN ${transaction(revisionIds)}
      ORDER BY id
      FOR UPDATE
    `;
    if (revisions.length !== 5) {
      throw new AppError({
        statusCode: 404,
        code: "DAILY_SET_REVISION_NOT_FOUND",
        message: "편성할 문제 리비전 중 찾을 수 없는 항목이 있습니다.",
      });
    }
    if (
      revisions.some((revision) => revision.lifecycle_status !== "published")
    ) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_REVISION_NOT_PUBLISHED",
        message: "게시된 문제 리비전만 편성할 수 있습니다.",
      });
    }

    const sets = await transaction<DailySetRow[]>`
      INSERT INTO daily_sets (quiz_date, status)
      VALUES (${request.quizDate}, 'draft')
      ON CONFLICT (quiz_date) DO NOTHING
      RETURNING
        id,
        quiz_date::text AS quiz_date,
        version::int AS version,
        status::text AS status,
        published_at
    `;
    const dailySet = sets[0];
    if (dailySet === undefined) {
      throw new AppError({
        statusCode: 409,
        code: "DAILY_SET_QUIZ_DATE_CONFLICT",
        message: "해당 날짜의 데일리 세트가 이미 존재합니다.",
      });
    }

    for (const [index, item] of request.items.entries()) {
      await transaction`
        INSERT INTO daily_set_items (
          daily_set_id,
          position,
          question_revision_id,
          choice_order
        )
        VALUES (
          ${dailySet.id},
          ${index + 1},
          ${item.revisionId},
          ${JSON.stringify(item.choiceOrder)}::jsonb
        )
      `;
    }

    const action = "daily_set.create";
    await insertAuditLog(
      transaction,
      actorSubject,
      action,
      "daily_set",
      dailySet.id,
      { action, status: "draft" },
    );

    return AdminCreateDailySetDraftResponseSchema.parse({
      dailySetId: dailySet.id,
      quizDate: dailySet.quiz_date,
      version: dailySet.version,
      status: "draft",
      items: request.items,
    });
  });
}

export async function publishDailySet(
  database: Database,
  actorSubject: string,
  dailySetId: string,
  now = new Date(),
): Promise<AdminPublishDailySetResponse> {
  return database.client.begin(async (transaction) => {
    // Publishing is serialized so two nearby quiz dates cannot concurrently
    // pass the rolling logical-question uniqueness check.
    await transaction`SELECT pg_advisory_xact_lock(1378035794)`;

    const sets = await transaction<DailySetRow[]>`
      SELECT
        id,
        quiz_date::text AS quiz_date,
        version::int AS version,
        status::text AS status,
        published_at
      FROM daily_sets
      WHERE id = ${dailySetId}
      FOR UPDATE
    `;
    const dailySet = sets[0];
    if (dailySet === undefined) {
      throw new AppError({
        statusCode: 404,
        code: "DAILY_SET_NOT_FOUND",
        message: "데일리 세트를 찾을 수 없습니다.",
      });
    }
    if (dailySet.status !== "draft") {
      throw new AppError({
        statusCode: 409,
        code: "DAILY_SET_NOT_DRAFT",
        message: "초안 상태의 데일리 세트만 게시할 수 있습니다.",
      });
    }

    const items = await transaction<DailySetItemRow[]>`
      SELECT
        position::int AS position,
        question_revision_id
      FROM daily_set_items
      WHERE daily_set_id = ${dailySetId}
      ORDER BY position
      FOR UPDATE
    `;
    if (
      items.length !== 5 ||
      items.some((item, index) => item.position !== index + 1)
    ) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_ITEM_COUNT_INVALID",
        message: "데일리 세트에는 순서가 지정된 5문제가 필요합니다.",
      });
    }

    const revisionIds = items.map((item) => item.question_revision_id);
    const revisions = await transaction<QuestionRevisionRow[]>`
      SELECT
        id,
        question_id,
        revision_number::int AS revision_number,
        category,
        difficulty::text AS difficulty,
        lifecycle_status::text AS lifecycle_status,
        source_checked_at,
        time_sensitive,
        valid_until,
        published_at,
        retired_at,
        created_at
      FROM question_revisions
      WHERE id IN ${transaction(revisionIds)}
      ORDER BY id
      FOR UPDATE
    `;
    if (revisions.length !== 5) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_REVISION_INTEGRITY_ERROR",
        message: "데일리 세트의 문제 리비전 구성이 올바르지 않습니다.",
      });
    }
    if (
      revisions.some((revision) => revision.lifecycle_status !== "published")
    ) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_REVISION_NOT_PUBLISHED",
        message: "게시된 문제 리비전만 데일리 세트에 사용할 수 있습니다.",
      });
    }

    const questionIds = revisions.map((revision) => revision.question_id);
    if (new Set(questionIds).size !== 5) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_LOGICAL_QUESTIONS_NOT_DISTINCT",
        message: "서로 다른 논리 문제 5개가 필요합니다.",
      });
    }

    const difficultyCounts = { easy: 0, medium: 0, hard: 0 };
    const categoryCounts = new Map<string, number>();
    for (const revision of revisions) {
      difficultyCounts[revision.difficulty] += 1;
      categoryCounts.set(
        revision.category,
        (categoryCounts.get(revision.category) ?? 0) + 1,
      );
    }
    if (
      difficultyCounts.easy !== 2 ||
      difficultyCounts.hard > 1 ||
      difficultyCounts.medium !== 3 - difficultyCounts.hard
    ) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID",
        message:
          "난이도 구성은 쉬움 2개, 어려움 최대 1개이며 나머지는 보통이어야 합니다.",
      });
    }
    if ([...categoryCounts.values()].some((count) => count > 2)) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_CATEGORY_LIMIT_EXCEEDED",
        message: "같은 카테고리는 최대 2개까지 편성할 수 있습니다.",
      });
    }

    // A KST quiz dated D remains available through D+1 01:00 KST, which is
    // D 16:00 UTC. Time-sensitive content must remain valid beyond that point.
    const quizCompletionDeadline = new Date(
      `${dailySet.quiz_date}T16:00:00.000Z`,
    );
    if (
      revisions.some(
        (revision) =>
          revision.time_sensitive &&
          (revision.valid_until === null ||
            new Date(revision.valid_until) <= quizCompletionDeadline),
      )
    ) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_REVISION_VALIDITY_EXPIRED",
        message:
          "퀴즈 제공 종료 전에 만료되는 시의성 문제를 게시할 수 없습니다.",
      });
    }

    const recentMatches = await transaction<{ question_id: string }[]>`
      SELECT qr.question_id
      FROM daily_sets ds
      JOIN daily_set_items dsi ON dsi.daily_set_id = ds.id
      JOIN question_revisions qr ON qr.id = dsi.question_revision_id
      WHERE ds.status = 'published'
        AND ds.quiz_date >= ${dailySet.quiz_date}::date - 14
        AND ds.quiz_date <= ${dailySet.quiz_date}::date + 14
        AND ds.id <> ${dailySetId}
        AND qr.question_id IN ${transaction(questionIds)}
      LIMIT 1
    `;
    if (recentMatches[0] !== undefined) {
      throw new AppError({
        statusCode: 422,
        code: "DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED",
        message: "전후 14일 내 게시된 논리 문제를 다시 편성할 수 없습니다.",
      });
    }

    const updatedSets = await transaction<DailySetRow[]>`
      UPDATE daily_sets
      SET status = 'published', published_at = ${now.toISOString()}
      WHERE id = ${dailySetId} AND status = 'draft'
      RETURNING
        id,
        quiz_date::text AS quiz_date,
        version::int AS version,
        status::text AS status,
        published_at
    `;
    const published = updatedSets[0];
    if (published === undefined || published.published_at === null) {
      throw new AppError({
        statusCode: 409,
        code: "DAILY_SET_PUBLISH_CONFLICT",
        message: "데일리 세트를 게시할 수 없습니다.",
      });
    }

    const action = "daily_set.publish";
    await insertAuditLog(
      transaction,
      actorSubject,
      action,
      "daily_set",
      dailySetId,
      { action, status: "published" },
    );

    return AdminPublishDailySetResponseSchema.parse({
      dailySetId: published.id,
      quizDate: published.quiz_date,
      version: published.version,
      status: "published",
      publishedAt: toIsoDateTime(published.published_at),
    });
  });
}
