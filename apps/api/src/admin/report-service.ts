import {
  AdminListReportsResponseSchema,
  AdminUpdateReportStatusResponseSchema,
  IsoDateTimeSchema,
  UuidSchema,
  type AdminListReportsQuery,
  type AdminListReportsResponse,
  type AdminUpdateReportStatusResponse,
  type ContentStatus,
  type ReportReason,
  type ReportStatus,
  type ReportTriageStatus,
} from "@daily-quiz-battle/contracts";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";

interface ReportListRow {
  id: string;
  question_revision_id: string | null;
  challenge_id: string | null;
  question_id: string | null;
  context_revision_id: string | null;
  revision_number: number | null;
  prompt: string | null;
  category: string | null;
  content_status: ContentStatus | null;
  reason_code: ReportReason;
  detail: string | null;
  created_at: Date | string;
  status: ReportStatus;
  triaged_by: string | null;
  triaged_at: Date | string | null;
}

interface LockedReportRow {
  id: string;
  status: ReportStatus;
  triaged_by: string | null;
  triaged_at: Date | string | null;
}

const PaginationCursorPayloadSchema = z.object({
  createdAt: IsoDateTimeSchema,
  id: UuidSchema,
});

type PaginationCursorPayload = z.infer<typeof PaginationCursorPayloadSchema>;

const LEGAL_STATUS_TRANSITIONS: Record<
  ReportStatus,
  readonly ReportTriageStatus[]
> = {
  open: ["reviewing", "resolved", "dismissed"],
  reviewing: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      statusCode: 500,
      code: "REPORT_DATA_INTEGRITY_ERROR",
      message: "신고 처리 결과를 불러오지 못했습니다.",
    });
  }
  return date.toISOString();
}

function toNullableIsoDateTime(value: Date | string | null): string | null {
  return value === null ? null : toIsoDateTime(value);
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
    // Malformed opaque cursors use the standard request-validation response.
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

function reportNotFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: "REPORT_NOT_FOUND",
    message: "신고를 찾을 수 없습니다.",
  });
}

function reportStatusTransitionInvalid(
  fromStatus: ReportStatus,
  toStatus: ReportTriageStatus,
): AppError {
  return new AppError({
    statusCode: 409,
    code: "REPORT_STATUS_TRANSITION_INVALID",
    message: "허용되지 않는 신고 상태 변경입니다.",
    details: { from: fromStatus, to: toStatus },
  });
}

function toUpdateResponse(
  report: LockedReportRow,
): AdminUpdateReportStatusResponse {
  if (
    report.status === "open" ||
    report.triaged_by === null ||
    report.triaged_at === null
  ) {
    throw new AppError({
      statusCode: 500,
      code: "REPORT_DATA_INTEGRITY_ERROR",
      message: "신고 처리 결과를 불러오지 못했습니다.",
    });
  }

  return AdminUpdateReportStatusResponseSchema.parse({
    reportId: report.id,
    status: report.status,
    triagedBy: report.triaged_by,
    triagedAt: toIsoDateTime(report.triaged_at),
  });
}

export async function listReports(
  database: Database,
  query: AdminListReportsQuery,
): Promise<AdminListReportsResponse> {
  const cursor = decodePaginationCursor(query.cursor);
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const status = query.status ?? null;
  const reasonCode = query.reasonCode ?? null;
  const rows = await database.client<ReportListRow[]>`
    SELECT
      r.id,
      r.question_revision_id,
      r.challenge_id,
      qr.question_id,
      qr.id AS context_revision_id,
      qr.revision_number::int AS revision_number,
      qr.prompt,
      qr.category,
      qr.lifecycle_status::text AS content_status,
      r.reason_code,
      r.detail,
      r.created_at,
      r.status::text AS status,
      r.triaged_by,
      r.triaged_at
    FROM reports r
    LEFT JOIN question_revisions qr
      ON qr.id = r.question_revision_id
    WHERE (
      ${status}::report_status IS NULL
      OR r.status = ${status}::report_status
    )
      AND (
        ${reasonCode}::varchar IS NULL
        OR r.reason_code = ${reasonCode}
      )
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (r.created_at, r.id) < (
          ${cursorCreatedAt}::timestamptz,
          ${cursorId}::uuid
        )
      )
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${query.limit + 1}
  `;
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const lastRow = page.at(-1);

  return AdminListReportsResponseSchema.parse({
    reports: page.map((row) => ({
      reportId: row.id,
      questionRevisionId: row.question_revision_id,
      challengeId: row.challenge_id,
      questionContext:
        row.context_revision_id === null
          ? null
          : {
              questionId: row.question_id,
              revisionId: row.context_revision_id,
              revisionNumber: row.revision_number,
              prompt: row.prompt,
              category: row.category,
              status: row.content_status,
            },
      reasonCode: row.reason_code,
      detail: row.detail,
      createdAt: toIsoDateTime(row.created_at),
      status: row.status,
      triagedBy: row.triaged_by,
      triagedAt: toNullableIsoDateTime(row.triaged_at),
    })),
    nextCursor:
      hasNextPage && lastRow !== undefined
        ? encodePaginationCursor(lastRow)
        : null,
  });
}

export async function updateReportStatus(
  database: Database,
  actorSubject: string,
  reportId: string,
  status: ReportTriageStatus,
  now = new Date(),
): Promise<AdminUpdateReportStatusResponse> {
  return database.client.begin(async (transaction) => {
    const reports = await transaction<LockedReportRow[]>`
      SELECT
        id,
        status::text AS status,
        triaged_by,
        triaged_at
      FROM reports
      WHERE id = ${reportId}
      FOR UPDATE
    `;
    const report = reports[0];
    if (report === undefined) {
      throw reportNotFound();
    }

    if (report.status === status) {
      return toUpdateResponse(report);
    }

    if (!LEGAL_STATUS_TRANSITIONS[report.status].includes(status)) {
      throw reportStatusTransitionInvalid(report.status, status);
    }

    const triagedAt = toIsoDateTime(now);
    const updatedRows = await transaction<LockedReportRow[]>`
      UPDATE reports
      SET
        status = ${status}::report_status,
        triaged_by = ${actorSubject},
        triaged_at = ${triagedAt}
      WHERE id = ${reportId}
      RETURNING
        id,
        status::text AS status,
        triaged_by,
        triaged_at
    `;
    const updated = updatedRows[0];
    if (updated === undefined) {
      throw reportNotFound();
    }

    const action = "report.status.update";
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
        'question_report',
        ${reportId},
        ${JSON.stringify({
          action,
          fromStatus: report.status,
          toStatus: status,
        })}::jsonb
      )
    `;

    return toUpdateResponse(updated);
  });
}
