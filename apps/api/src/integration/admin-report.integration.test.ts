import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  AdminListReportsResponseSchema,
  AdminUpdateReportStatusResponseSchema,
  ApiErrorSchema,
  BootstrapResponseSchema,
  type ContentStatus,
  type ReportReason,
  type ReportStatus,
  type ReportTriageStatus,
} from "@daily-quiz-battle/contracts";
import { createAdminAccessTokenService } from "../admin/token.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

interface JsonResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

interface ReportFixture {
  reportId: string;
  reporterUserId: string;
  reporterFingerprint: string;
  questionRevisionId: string | null;
  challengeId: string | null;
  detail: string | null;
}

interface InsertReportOptions {
  reasonCode?: ReportReason;
  detail?: string | null;
  createdAt?: string;
  status?: ReportStatus;
  target?: "question" | "challenge";
  triagedBy?: string;
  triagedAt?: string;
}

interface QuestionContextFixture {
  questionId: string;
  revisionId: string;
  revisionNumber: number;
  prompt: string;
  category: string;
  status: ContentStatus;
}

const ADMIN_REPORTS_URL = "/v1/admin/reports";
const FIXTURE_TRIAGED_AT = "2043-01-01T00:00:00.000Z";
const TRIAGE_TIME = "2044-02-03T04:05:06.000Z";
let harness: IntegrationHarness;
let questionRevisionId: string;
let expectedQuestionContext: QuestionContextFixture;

before(async () => {
  harness = await createIntegrationHarness();
  const revisions = await harness.database.client<
    {
      question_id: string;
      revision_id: string;
      revision_number: number;
      prompt: string;
      category: string;
      status: ContentStatus;
    }[]
  >`
    SELECT
      question_id,
      id AS revision_id,
      revision_number::int AS revision_number,
      prompt,
      category,
      lifecycle_status::text AS status
    FROM question_revisions
    ORDER BY id
    LIMIT 1
  `;
  const revision = revisions[0];
  assert.ok(revision, "seeded question revision is required");
  questionRevisionId = revision.revision_id;
  expectedQuestionContext = {
    questionId: revision.question_id,
    revisionId: revision.revision_id,
    revisionNumber: revision.revision_number,
    prompt: revision.prompt,
    category: revision.category,
    status: revision.status,
  };
});

after(async () => {
  await harness?.close();
});

function authorizationHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function toIsoDateTime(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
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

async function issueAdminToken(
  actorSubject: string,
  scopes: string[],
): Promise<string> {
  return createAdminAccessTokenService(harness.config).issue({
    actorSubject,
    scopes,
  });
}

async function bootstrapUser(anonymousKey: string): Promise<string> {
  const developmentAnonymousKey = anonymousKey.startsWith("dev-")
    ? anonymousKey
    : `dev-${anonymousKey}`;
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey: developmentAnonymousKey },
  });
  assert.equal(response.statusCode, 200, response.body);
  return BootstrapResponseSchema.parse(response.json()).accessToken;
}

async function resetReportFixtures(): Promise<void> {
  await harness.database.client`
    DELETE FROM admin_audit_logs
    WHERE resource_type = 'question_report'
  `;
  await harness.database.client`DELETE FROM reports`;
}

async function insertReport(
  options: InsertReportOptions = {},
): Promise<ReportFixture> {
  const status = options.status ?? "open";
  const target = options.target ?? "question";
  const createdAt = options.createdAt ?? "2043-02-01T00:00:00.000Z";
  const triagedBy =
    status === "open" ? null : (options.triagedBy ?? "fixture-operator");
  const triagedAt =
    status === "open" ? null : (options.triagedAt ?? FIXTURE_TRIAGED_AT);
  const fingerprint = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const challengeId = target === "challenge" ? randomUUID() : null;
  const targetQuestionRevisionId =
    target === "question" ? questionRevisionId : null;

  return harness.database.client.begin(async (transaction) => {
    const users = await transaction<{ id: string }[]>`
      INSERT INTO users (
        anon_key_fingerprint,
        identity_verified_at,
        created_at,
        updated_at
      )
      VALUES (
        ${fingerprint},
        ${createdAt},
        ${createdAt},
        ${createdAt}
      )
      RETURNING id
    `;
    const user = users[0];
    assert.ok(user);

    const reports = await transaction<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id,
        question_revision_id,
        challenge_id,
        reason_code,
        detail,
        status,
        triaged_by,
        triaged_at,
        created_at
      )
      VALUES (
        ${user.id},
        ${targetQuestionRevisionId}::uuid,
        ${challengeId}::uuid,
        ${options.reasonCode ?? "other"},
        ${options.detail ?? null},
        ${status}::report_status,
        ${triagedBy},
        ${triagedAt},
        ${createdAt}
      )
      RETURNING id
    `;
    const report = reports[0];
    assert.ok(report);

    return {
      reportId: report.id,
      reporterUserId: user.id,
      reporterFingerprint: fingerprint,
      questionRevisionId: targetQuestionRevisionId,
      challengeId,
      detail: options.detail ?? null,
    };
  });
}

async function patchStatus(token: string, reportId: string, status: string) {
  return harness.app.inject({
    method: "PATCH",
    url: `${ADMIN_REPORTS_URL}/${reportId}/status`,
    headers: authorizationHeaders(token),
    payload: { status },
  });
}

test("admin report routes require admin authentication and separate read from triage scope", async () => {
  await resetReportFixtures();
  const fixture = await insertReport({ detail: "internal report detail" });
  const readToken = await issueAdminToken("report-reader", ["reports:read"]);
  const triageToken = await issueAdminToken("report-triager", [
    "reports:triage",
  ]);
  const contentToken = await issueAdminToken("content-writer", [
    "content:write",
  ]);
  const publicUserToken = await bootstrapUser(
    `admin-report-public-${randomUUID().replaceAll("-", "")}`,
  );

  const unauthenticatedList = await harness.app.inject({
    method: "GET",
    url: ADMIN_REPORTS_URL,
  });
  expectApiError(unauthenticatedList, 401, "ADMIN_UNAUTHORIZED");

  const unauthenticatedPatch = await harness.app.inject({
    method: "PATCH",
    url: `${ADMIN_REPORTS_URL}/${fixture.reportId}/status`,
    payload: { status: "reviewing" },
  });
  expectApiError(unauthenticatedPatch, 401, "ADMIN_UNAUTHORIZED");

  const publicCredentialList = await harness.app.inject({
    method: "GET",
    url: ADMIN_REPORTS_URL,
    headers: authorizationHeaders(publicUserToken),
  });
  expectApiError(publicCredentialList, 401, "ADMIN_UNAUTHORIZED");
  assert.equal(
    publicCredentialList.body.includes(fixture.reporterUserId),
    false,
  );
  assert.equal(
    publicCredentialList.body.includes(fixture.reporterFingerprint),
    false,
  );
  assert.equal(publicCredentialList.body.includes(fixture.detail!), false);
  assert.equal(publicCredentialList.body.includes("questionContext"), false);

  const publicCredentialPatch = await patchStatus(
    publicUserToken,
    fixture.reportId,
    "reviewing",
  );
  expectApiError(publicCredentialPatch, 401, "ADMIN_UNAUTHORIZED");

  const triageCannotRead = await harness.app.inject({
    method: "GET",
    url: ADMIN_REPORTS_URL,
    headers: authorizationHeaders(triageToken),
  });
  expectApiError(triageCannotRead, 403, "ADMIN_FORBIDDEN");

  const readCannotTriage = await patchStatus(
    readToken,
    fixture.reportId,
    "reviewing",
  );
  expectApiError(readCannotTriage, 403, "ADMIN_FORBIDDEN");

  const contentCannotRead = await harness.app.inject({
    method: "GET",
    url: ADMIN_REPORTS_URL,
    headers: authorizationHeaders(contentToken),
  });
  expectApiError(contentCannotRead, 403, "ADMIN_FORBIDDEN");

  const readable = await harness.app.inject({
    method: "GET",
    url: ADMIN_REPORTS_URL,
    headers: authorizationHeaders(readToken),
  });
  assert.equal(readable.statusCode, 200, readable.body);
  AdminListReportsResponseSchema.parse(readable.json());

  harness.setNow(TRIAGE_TIME);
  const triaged = await patchStatus(triageToken, fixture.reportId, "reviewing");
  assert.equal(triaged.statusCode, 200, triaged.body);
  const result = AdminUpdateReportStatusResponseSchema.parse(triaged.json());
  assert.equal(result.status, "reviewing");
  assert.equal(result.triagedBy, "report-triager");
});

test("admin report routes validate query, params, and status bodies and return 404 for missing reports", async () => {
  await resetReportFixtures();
  const fixture = await insertReport();
  const readToken = await issueAdminToken("validation-reader", [
    "reports:read",
  ]);
  const triageToken = await issueAdminToken("validation-triager", [
    "reports:triage",
  ]);

  const invalidQueries = [
    "status=unknown",
    "reasonCode=unknown",
    "limit=0",
    "limit=101",
    "cursor=bm90LWpzb24",
    "unexpected=value",
  ];
  for (const query of invalidQueries) {
    const response = await harness.app.inject({
      method: "GET",
      url: `${ADMIN_REPORTS_URL}?${query}`,
      headers: authorizationHeaders(readToken),
    });
    expectApiError(response, 400, "INVALID_REQUEST");
  }

  const invalidId = await patchStatus(triageToken, "not-a-uuid", "reviewing");
  expectApiError(invalidId, 400, "INVALID_REQUEST");

  const openTarget = await patchStatus(triageToken, fixture.reportId, "open");
  expectApiError(openTarget, 400, "INVALID_REQUEST");

  const extraBodyField = await harness.app.inject({
    method: "PATCH",
    url: `${ADMIN_REPORTS_URL}/${fixture.reportId}/status`,
    headers: authorizationHeaders(triageToken),
    payload: { status: "reviewing", detail: "must not be accepted" },
  });
  expectApiError(extraBodyField, 400, "INVALID_REQUEST");

  const missing = await patchStatus(triageToken, randomUUID(), "reviewing");
  expectApiError(missing, 404, "REPORT_NOT_FOUND");
});

test("admin report list returns exact target context while filtering and paginating without exposing reporters", async () => {
  await resetReportFixtures();
  const tiedCreatedAt = "2045-01-02T03:04:05.000Z";
  const matching = await Promise.all([
    insertReport({
      reasonCode: "ambiguous",
      detail: "first private detail",
      createdAt: tiedCreatedAt,
    }),
    insertReport({
      reasonCode: "ambiguous",
      detail: "second private detail",
      createdAt: tiedCreatedAt,
      target: "challenge",
    }),
    insertReport({
      reasonCode: "ambiguous",
      detail: null,
      createdAt: tiedCreatedAt,
    }),
  ]);
  const resolved = await insertReport({
    reasonCode: "ambiguous",
    detail: "resolved detail",
    createdAt: "2045-01-03T00:00:00.000Z",
    status: "resolved",
  });
  const outdated = await insertReport({
    reasonCode: "outdated",
    detail: "outdated detail",
    createdAt: "2045-01-04T00:00:00.000Z",
  });
  const readToken = await issueAdminToken("pagination-reader", [
    "reports:read",
  ]);

  const expectedRows = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM reports
    WHERE status = 'open'
      AND reason_code = 'ambiguous'
    ORDER BY created_at DESC, id DESC
  `;
  const expectedIds = expectedRows.map((row) => row.id);
  assert.equal(expectedIds.length, matching.length);

  const firstResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_REPORTS_URL}?status=open&reasonCode=ambiguous&limit=2`,
    headers: authorizationHeaders(readToken),
  });
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  const first = AdminListReportsResponseSchema.parse(firstResponse.json());
  assert.deepEqual(
    first.reports.map((report) => report.reportId),
    expectedIds.slice(0, 2),
  );
  assert.ok(first.nextCursor);

  const secondResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_REPORTS_URL}?status=open&reasonCode=ambiguous&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    headers: authorizationHeaders(readToken),
  });
  assert.equal(secondResponse.statusCode, 200, secondResponse.body);
  const second = AdminListReportsResponseSchema.parse(secondResponse.json());
  assert.deepEqual(
    second.reports.map((report) => report.reportId),
    expectedIds.slice(2),
  );
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set(
      [...first.reports, ...second.reports].map((report) => report.reportId),
    ).size,
    matching.length,
  );

  const allMatchingReports = [...first.reports, ...second.reports];
  const listedDetails = new Set(
    allMatchingReports.map((report) => report.detail),
  );
  assert.deepEqual(
    listedDetails,
    new Set(["first private detail", "second private detail", null]),
  );
  assert.ok(
    allMatchingReports.some(
      (report) =>
        report.questionRevisionId === null && report.challengeId !== null,
    ),
  );
  assert.ok(
    allMatchingReports.some(
      (report) =>
        report.questionRevisionId !== null && report.challengeId === null,
    ),
  );
  const questionReports = allMatchingReports.filter(
    (report) => report.questionRevisionId !== null,
  );
  assert.equal(questionReports.length, 2);
  for (const report of questionReports) {
    assert.deepEqual(report.questionContext, expectedQuestionContext);
    assert.equal(report.questionContext?.revisionId, report.questionRevisionId);
  }
  const challengeReport = allMatchingReports.find(
    (report) => report.challengeId !== null,
  );
  assert.ok(challengeReport);
  assert.equal(challengeReport.questionContext, null);

  const serialized = JSON.stringify([first, second]);
  for (const fixture of matching) {
    assert.equal(serialized.includes(fixture.reporterUserId), false);
    assert.equal(serialized.includes(fixture.reporterFingerprint), false);
  }
  assert.equal(serialized.includes("reporterUserId"), false);
  assert.equal(serialized.includes("reporter_user_id"), false);

  const resolvedResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_REPORTS_URL}?status=resolved`,
    headers: authorizationHeaders(readToken),
  });
  assert.equal(resolvedResponse.statusCode, 200, resolvedResponse.body);
  const resolvedList = AdminListReportsResponseSchema.parse(
    resolvedResponse.json(),
  );
  assert.deepEqual(
    resolvedList.reports.map((report) => report.reportId),
    [resolved.reportId],
  );

  const reasonResponse = await harness.app.inject({
    method: "GET",
    url: `${ADMIN_REPORTS_URL}?reasonCode=outdated`,
    headers: authorizationHeaders(readToken),
  });
  assert.equal(reasonResponse.statusCode, 200, reasonResponse.body);
  const reasonList = AdminListReportsResponseSchema.parse(
    reasonResponse.json(),
  );
  assert.deepEqual(
    reasonList.reports.map((report) => report.reportId),
    [outdated.reportId],
  );
});

test("report triage permits every forward transition and persists the operator and clock", async () => {
  await resetReportFixtures();
  harness.setNow(TRIAGE_TIME);
  const actorSubject = "legal-transition-operator";
  const token = await issueAdminToken(actorSubject, ["reports:triage"]);
  const legalTransitions: ReadonlyArray<
    readonly [ReportStatus, ReportTriageStatus]
  > = [
    ["open", "reviewing"],
    ["open", "resolved"],
    ["open", "dismissed"],
    ["reviewing", "resolved"],
    ["reviewing", "dismissed"],
  ];

  for (const [fromStatus, toStatus] of legalTransitions) {
    const fixture = await insertReport({ status: fromStatus });
    const response = await patchStatus(token, fixture.reportId, toStatus);
    assert.equal(
      response.statusCode,
      200,
      `${fromStatus} -> ${toStatus}: ${response.body}`,
    );
    const result = AdminUpdateReportStatusResponseSchema.parse(response.json());
    assert.deepEqual(result, {
      reportId: fixture.reportId,
      status: toStatus,
      triagedBy: actorSubject,
      triagedAt: TRIAGE_TIME,
    });

    const persisted = await harness.database.client<
      { status: string; triaged_by: string; triaged_at: Date | string }[]
    >`
      SELECT status::text AS status, triaged_by, triaged_at
      FROM reports
      WHERE id = ${fixture.reportId}
    `;
    assert.equal(persisted[0]?.status, toStatus);
    assert.equal(persisted[0]?.triaged_by, actorSubject);
    assert.equal(toIsoDateTime(persisted[0]!.triaged_at), TRIAGE_TIME);
  }
});

test("same-target triage replay is deterministic and does not add an audit row", async () => {
  await resetReportFixtures();
  harness.setNow(TRIAGE_TIME);
  const token = await issueAdminToken("replay-attempt-operator", [
    "reports:triage",
  ]);
  const replayStatuses: readonly ReportTriageStatus[] = [
    "reviewing",
    "resolved",
    "dismissed",
  ];

  for (const status of replayStatuses) {
    const fixture = await insertReport({
      status,
      triagedBy: "original-operator",
      triagedAt: FIXTURE_TRIAGED_AT,
    });
    const response = await patchStatus(token, fixture.reportId, status);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      AdminUpdateReportStatusResponseSchema.parse(response.json()),
      {
        reportId: fixture.reportId,
        status,
        triagedBy: "original-operator",
        triagedAt: FIXTURE_TRIAGED_AT,
      },
    );
  }

  const auditCount = await harness.database.client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM admin_audit_logs
    WHERE resource_type = 'question_report'
  `;
  assert.equal(auditCount[0]?.count, 0);
});

test("report triage rejects open targets and every accepted backward or cross-terminal transition", async () => {
  await resetReportFixtures();
  const token = await issueAdminToken("illegal-transition-operator", [
    "reports:triage",
  ]);
  const allStatuses: readonly ReportStatus[] = [
    "open",
    "reviewing",
    "resolved",
    "dismissed",
  ];
  for (const fromStatus of allStatuses) {
    const fixture = await insertReport({ status: fromStatus });
    const response = await patchStatus(token, fixture.reportId, "open");
    expectApiError(response, 400, "INVALID_REQUEST");
  }

  const illegalTransitions: ReadonlyArray<
    readonly ["resolved" | "dismissed", ReportTriageStatus]
  > = [
    ["resolved", "reviewing"],
    ["resolved", "dismissed"],
    ["dismissed", "reviewing"],
    ["dismissed", "resolved"],
  ];

  for (const [fromStatus, toStatus] of illegalTransitions) {
    const fixture = await insertReport({
      status: fromStatus,
      triagedBy: "terminal-owner",
      triagedAt: FIXTURE_TRIAGED_AT,
    });
    const response = await patchStatus(token, fixture.reportId, toStatus);
    expectApiError(response, 409, "REPORT_STATUS_TRANSITION_INVALID");

    const persisted = await harness.database.client<
      { status: string; triaged_by: string; triaged_at: Date | string }[]
    >`
      SELECT status::text AS status, triaged_by, triaged_at
      FROM reports
      WHERE id = ${fixture.reportId}
    `;
    assert.equal(persisted[0]?.status, fromStatus);
    assert.equal(persisted[0]?.triaged_by, "terminal-owner");
    assert.equal(toIsoDateTime(persisted[0]!.triaged_at), FIXTURE_TRIAGED_AT);
  }
});

test("concurrent terminal triage serializes on the report so exactly one target wins", async () => {
  await resetReportFixtures();
  harness.setNow(TRIAGE_TIME);
  const fixture = await insertReport({
    status: "reviewing",
    triagedBy: "initial-reviewer",
    triagedAt: FIXTURE_TRIAGED_AT,
  });
  const resolvedToken = await issueAdminToken("resolve-operator", [
    "reports:triage",
  ]);
  const dismissedToken = await issueAdminToken("dismiss-operator", [
    "reports:triage",
  ]);

  const responses = await Promise.all([
    patchStatus(resolvedToken, fixture.reportId, "resolved"),
    patchStatus(dismissedToken, fixture.reportId, "dismissed"),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  const winnerResponse = responses.find(
    (response) => response.statusCode === 200,
  );
  const loserResponse = responses.find(
    (response) => response.statusCode === 409,
  );
  assert.ok(winnerResponse);
  assert.ok(loserResponse);
  expectApiError(loserResponse, 409, "REPORT_STATUS_TRANSITION_INVALID");
  const winner = AdminUpdateReportStatusResponseSchema.parse(
    winnerResponse.json(),
  );

  const persisted = await harness.database.client<
    { status: string; triaged_by: string; triaged_at: Date | string }[]
  >`
    SELECT status::text AS status, triaged_by, triaged_at
    FROM reports
    WHERE id = ${fixture.reportId}
  `;
  assert.equal(persisted[0]?.status, winner.status);
  assert.equal(persisted[0]?.triaged_by, winner.triagedBy);
  assert.equal(toIsoDateTime(persisted[0]!.triaged_at), TRIAGE_TIME);
  const expectedWinnerActor =
    winner.status === "resolved" ? "resolve-operator" : "dismiss-operator";
  assert.equal(winner.triagedBy, expectedWinnerActor);

  const audits = await harness.database.client<
    { actor_subject: string; metadata: Record<string, unknown> }[]
  >`
    SELECT actor_subject, metadata
    FROM admin_audit_logs
    WHERE resource_type = 'question_report'
      AND resource_id = ${fixture.reportId}
  `;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.actor_subject, winner.triagedBy);
  assert.deepEqual(audits[0]?.metadata, {
    action: "report.status.update",
    fromStatus: "reviewing",
    toStatus: winner.status,
  });
});

test("database trigger keeps report core fields and terminal triage state immutable", async () => {
  await resetReportFixtures();
  const openFixture = await insertReport({
    reasonCode: "other",
    detail: "immutable original detail",
  });

  await assert.rejects(
    harness.database.client`
      UPDATE reports
      SET
        reason_code = 'outdated',
        detail = 'tampered detail'
      WHERE id = ${openFixture.reportId}
    `,
    /report core columns are immutable/,
  );
  const unchangedOpen = await harness.database.client<
    { reason_code: string; detail: string | null }[]
  >`
    SELECT reason_code, detail
    FROM reports
    WHERE id = ${openFixture.reportId}
  `;
  assert.deepEqual(unchangedOpen[0], {
    reason_code: "other",
    detail: "immutable original detail",
  });

  const terminalFixture = await insertReport({
    status: "resolved",
    triagedBy: "terminal-operator",
    triagedAt: FIXTURE_TRIAGED_AT,
  });
  await assert.rejects(
    harness.database.client`
      UPDATE reports
      SET triaged_by = 'tampered-operator'
      WHERE id = ${terminalFixture.reportId}
    `,
    /terminal reports are immutable/,
  );
  const unchangedTerminal = await harness.database.client<
    { status: string; triaged_by: string; triaged_at: Date | string }[]
  >`
    SELECT status::text AS status, triaged_by, triaged_at
    FROM reports
    WHERE id = ${terminalFixture.reportId}
  `;
  assert.equal(unchangedTerminal[0]?.status, "resolved");
  assert.equal(unchangedTerminal[0]?.triaged_by, "terminal-operator");
  assert.equal(
    toIsoDateTime(unchangedTerminal[0]!.triaged_at),
    FIXTURE_TRIAGED_AT,
  );
});

test("successful triage writes one minimal audit row without reporter, detail, or token material", async () => {
  await resetReportFixtures();
  harness.setNow(TRIAGE_TIME);
  const actorSubject = "minimal-audit-operator";
  const token = await issueAdminToken(actorSubject, ["reports:triage"]);
  const fixture = await insertReport({
    reasonCode: "inappropriate",
    detail: "sensitive report detail that must not enter audit",
  });

  const response = await patchStatus(token, fixture.reportId, "reviewing");
  assert.equal(response.statusCode, 200, response.body);

  const audits = await harness.database.client<
    {
      actor_subject: string;
      action: string;
      resource_type: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }[]
  >`
    SELECT actor_subject, action, resource_type, resource_id, metadata
    FROM admin_audit_logs
    WHERE resource_type = 'question_report'
      AND resource_id = ${fixture.reportId}
  `;
  assert.equal(audits.length, 1);
  const audit = audits[0]!;
  assert.equal(audit.actor_subject, actorSubject);
  assert.equal(audit.action, "report.status.update");
  assert.equal(audit.resource_type, "question_report");
  assert.equal(audit.resource_id, fixture.reportId);
  assert.deepEqual(Object.keys(audit.metadata).sort(), [
    "action",
    "fromStatus",
    "toStatus",
  ]);
  assert.deepEqual(audit.metadata, {
    action: "report.status.update",
    fromStatus: "open",
    toStatus: "reviewing",
  });

  const serializedAudit = JSON.stringify(audit);
  assert.equal(serializedAudit.includes(fixture.reporterUserId), false);
  assert.equal(serializedAudit.includes(fixture.reporterFingerprint), false);
  assert.equal(serializedAudit.includes(fixture.detail!), false);
  assert.equal(serializedAudit.includes("questionContext"), false);
  assert.equal(
    serializedAudit.includes(expectedQuestionContext.questionId),
    false,
  );
  assert.equal(
    serializedAudit.includes(expectedQuestionContext.revisionId),
    false,
  );
  assert.equal(serializedAudit.includes(expectedQuestionContext.prompt), false);
  assert.equal(serializedAudit.includes(token), false);
});
