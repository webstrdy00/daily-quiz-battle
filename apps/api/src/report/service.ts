import {
  CreateReportResponseSchema,
  type CreateQuestionReportRequest,
  type CreateReportResponse,
} from "@daily-quiz-battle/contracts";
import type { TransactionSql } from "postgres";
import type { Database } from "../db/client.js";
import { AppError } from "../shared/errors.js";

interface ReportRow {
  id: string;
  created_at: Date | string;
}

async function lockActiveUser(
  transaction: TransactionSql<{}>,
  userId: string,
): Promise<void> {
  const users = await transaction<
    { identity_status: "active" | "deleted" | "blocked" }[]
  >`
    SELECT identity_status::text AS identity_status
    FROM users
    WHERE id = ${userId}
    FOR UPDATE
  `;
  if (users[0]?.identity_status !== "active") {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "현재 사용할 수 없는 계정입니다.",
    });
  }
}

function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      statusCode: 500,
      code: "DATA_INTEGRITY_ERROR",
      message: "신고 결과를 불러오지 못했습니다.",
    });
  }
  return date.toISOString();
}

export async function createQuestionReport(
  database: Database,
  userId: string,
  report: CreateQuestionReportRequest,
  now = new Date(),
): Promise<CreateReportResponse> {
  return database.client.begin(async (transaction) => {
    await lockActiveUser(transaction, userId);

    const accessible = await transaction`
      SELECT 1
      FROM attempts a
      WHERE a.user_id = ${userId}
        AND (
          EXISTS (
            SELECT 1
            FROM attempt_answers aa
            WHERE aa.attempt_id = a.id
              AND aa.question_revision_id = ${report.questionRevisionId}
          )
          OR EXISTS (
            SELECT 1
            FROM daily_set_items dsi
            WHERE dsi.daily_set_id = a.daily_set_id
              AND dsi.question_revision_id = ${report.questionRevisionId}
          )
        )
      LIMIT 1
    `;

    if (accessible.length === 0) {
      throw new AppError({
        statusCode: 404,
        code: "QUESTION_NOT_FOUND",
        message: "문항을 찾을 수 없습니다.",
      });
    }

    const createdAt = now.toISOString();
    const inserted = await transaction<ReportRow[]>`
      INSERT INTO reports (
        reporter_user_id,
        question_revision_id,
        reason_code,
        detail,
        created_at
      )
      VALUES (
        ${userId},
        ${report.questionRevisionId},
        ${report.reasonCode},
        ${report.detail ?? null},
        ${createdAt}
      )
      ON CONFLICT (
        reporter_user_id,
        question_revision_id,
        reason_code,
        dedupe_window_start
      ) WHERE question_revision_id IS NOT NULL
      DO NOTHING
      RETURNING id, created_at
    `;
    const insertedReport = inserted[0];

    if (insertedReport !== undefined) {
      return CreateReportResponseSchema.parse({
        id: insertedReport.id,
        deduplicated: false,
        createdAt: toIsoDateTime(insertedReport.created_at),
      });
    }

    const existing = await transaction<ReportRow[]>`
      SELECT id, created_at
      FROM reports
      WHERE reporter_user_id = ${userId}
        AND question_revision_id = ${report.questionRevisionId}
        AND reason_code = ${report.reasonCode}
        AND dedupe_window_start = date_bin(
          interval '10 minutes',
          ${createdAt}::timestamptz,
          timestamptz '1970-01-01 00:00:00+00'
        )
      LIMIT 1
    `;
    const existingReport = existing[0];

    if (existingReport === undefined) {
      throw new AppError({
        statusCode: 500,
        code: "REPORT_CREATE_FAILED",
        message: "신고를 접수하지 못했습니다.",
      });
    }

    return CreateReportResponseSchema.parse({
      id: existingReport.id,
      deduplicated: true,
      createdAt: toIsoDateTime(existingReport.created_at),
    });
  });
}
