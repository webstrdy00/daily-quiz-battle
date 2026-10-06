import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const IsoDateSchema = z.iso.date();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const AnswerIndexSchema = z.number().int().min(0).max(3);
export const QuestionSequenceSchema = z.number().int().min(1).max(5);
export const DifficultySchema = z.enum(["easy", "medium", "hard"]);
export const CategorySchema = z.string().trim().toLowerCase().min(1).max(32);
export const ContentStatusSchema = z.enum([
  "draft",
  "review",
  "approved",
  "published",
  "retired",
]);
export const DailySetStatusSchema = z.enum(["draft", "published", "retired"]);
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const BootstrapRequestSchema = z.object({
  anonymousKey: z
    .string()
    .min(8)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const BootstrapResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  user: z.object({
    id: UuidSchema,
    nickname: z.string().min(1).max(12),
  }),
});

export const RefreshSessionRequestSchema = BootstrapRequestSchema.extend({
  expectedUserId: UuidSchema,
}).strict();

export const OperationalCapabilitiesResponseSchema = z
  .object({
    analyticsPublishEnabled: z.boolean(),
    challengeCreateEnabled: z.boolean(),
    challengeClaimEnabled: z.boolean(),
  })
  .strict();

export const DeleteAccountRequestSchema = z.object({
  confirmation: z.literal("DELETE"),
});

export const DeleteAccountResponseSchema = z.object({
  status: z.literal("deleted"),
  deletedAt: IsoDateTimeSchema,
});

export const UpdateResultNotificationPreferenceRequestSchema = z.object({
  anonymousKey: z.string().min(8).max(512),
  enabled: z.boolean(),
});

export const ResultNotificationPreferenceResponseSchema = z.object({
  enabled: z.boolean(),
  deliveryAvailable: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});

export const AttemptStatusSchema = z.enum([
  "started",
  "completed",
  "abandoned",
]);

export const PublicQuestionSchema = z.object({
  sequence: QuestionSequenceSchema,
  revisionId: UuidSchema,
  prompt: z.string().min(1),
  choices: z.tuple([
    z.string().min(1),
    z.string().min(1),
    z.string().min(1),
    z.string().min(1),
  ]),
});

export const SavedAnswerSchema = z.object({
  sequence: QuestionSequenceSchema,
  questionRevisionId: UuidSchema,
  selectedIndex: AnswerIndexSchema,
});

export const QuizReviewItemSchema = z.object({
  sequence: QuestionSequenceSchema,
  prompt: z.string().min(1),
  selectedIndex: AnswerIndexSchema,
  correctIndex: AnswerIndexSchema,
  correct: z.boolean(),
  explanation: z.string().min(1),
});

export const CompletedAttemptResponseSchema = z.object({
  attemptId: UuidSchema,
  status: z.literal("completed"),
  score: z.number().int().min(0).max(5),
  total: z.literal(5),
  completedAt: IsoDateTimeSchema,
  review: z.array(QuizReviewItemSchema).length(5),
});

export const DailyAvailableStartResponseSchema = z.object({
  status: z.literal("available"),
  attempt: z.object({
    id: UuidSchema,
    status: AttemptStatusSchema,
    quizDate: IsoDateSchema,
    answeredCount: z.number().int().min(0).max(5),
    score: z.number().int().min(0).max(5).nullable(),
    answers: z.array(SavedAnswerSchema).max(5),
  }),
  questions: z.array(PublicQuestionSchema).length(5),
  completedResult: CompletedAttemptResponseSchema.optional(),
});

export const DailyVoidProjectionSchema = z.object({
  status: z.literal("voided"),
  quizDate: IsoDateSchema,
  voidedAt: IsoDateTimeSchema,
});

export const DailyStartResponseSchema = z.discriminatedUnion("status", [
  DailyAvailableStartResponseSchema,
  DailyVoidProjectionSchema,
]);

export const CompleteAttemptRequestSchema = z
  .object({
    answers: z
      .array(SavedAnswerSchema.strict())
      .length(5)
      .refine(
        (answers) =>
          new Set(answers.map((answer) => answer.sequence)).size === 5,
        {
          message: "문항 번호 1–5를 각각 한 번씩 제출해 주세요.",
        },
      ),
  })
  .strict();

export const VoidedAttemptResponseSchema = DailyVoidProjectionSchema.extend({
  attemptId: UuidSchema,
});

export const CompleteAttemptResponseSchema = z.discriminatedUnion("status", [
  CompletedAttemptResponseSchema,
  VoidedAttemptResponseSchema,
]);

// ---------------------------------------------------------------------------
// Admin content operations
// ---------------------------------------------------------------------------

export const QuestionChoicesSchema = z.tuple([
  z.string().trim().min(1),
  z.string().trim().min(1),
  z.string().trim().min(1),
  z.string().trim().min(1),
]);

export const ChoiceOrderSchema = z
  .tuple([
    AnswerIndexSchema,
    AnswerIndexSchema,
    AnswerIndexSchema,
    AnswerIndexSchema,
  ])
  .refine((choiceOrder) => new Set(choiceOrder).size === 4, {
    message: "choiceOrder must be a permutation of 0, 1, 2, and 3",
  });

export const AdminCreateQuestionRevisionRequestSchema = z
  .object({
    questionId: UuidSchema.optional(),
    category: CategorySchema,
    difficulty: DifficultySchema,
    prompt: z.string().trim().min(1).max(500),
    choices: QuestionChoicesSchema,
    correctIndex: AnswerIndexSchema,
    explanation: z.string().trim().min(1),
    sourceUrl: z.url(),
    sourceCheckedAt: IsoDateTimeSchema,
    reviewerId: z.string().trim().min(1).max(100),
    timeSensitive: z.boolean(),
    validUntil: IsoDateTimeSchema.nullable(),
    nextReviewAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((revision, context) => {
    if (!revision.timeSensitive) {
      return;
    }

    if (revision.validUntil === null) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil is required for time-sensitive content",
      });
    } else if (
      Date.parse(revision.validUntil) <= Date.parse(revision.sourceCheckedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must be after sourceCheckedAt",
      });
    }

    if (revision.nextReviewAt === null) {
      context.addIssue({
        code: "custom",
        path: ["nextReviewAt"],
        message: "nextReviewAt is required for time-sensitive content",
      });
    }
  });

export const AdminCreateQuestionRevisionResponseSchema = z.object({
  questionId: UuidSchema,
  revisionId: UuidSchema,
  revisionNumber: z.number().int().positive(),
  status: z.literal("draft"),
  createdAt: IsoDateTimeSchema,
});

export const AdminUpdateQuestionRevisionStatusRequestSchema = z.object({
  status: ContentStatusSchema,
});

export const AdminUpdateQuestionRevisionStatusResponseSchema = z.object({
  revisionId: UuidSchema,
  status: ContentStatusSchema,
  publishedAt: IsoDateTimeSchema.nullable(),
  retiredAt: IsoDateTimeSchema.nullable(),
});

export const AdminDailySetDraftItemSchema = z.object({
  revisionId: UuidSchema,
  choiceOrder: ChoiceOrderSchema,
});

export const AdminCreateDailySetDraftRequestSchema = z.object({
  quizDate: IsoDateSchema,
  items: z.tuple([
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
  ]),
});

export const AdminCreateDailySetDraftResponseSchema = z.object({
  dailySetId: UuidSchema,
  quizDate: IsoDateSchema,
  version: z.number().int().positive(),
  status: z.literal("draft"),
  items: z.tuple([
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
    AdminDailySetDraftItemSchema,
  ]),
});

export const AdminPublishDailySetResponseSchema = z.object({
  dailySetId: UuidSchema,
  quizDate: IsoDateSchema,
  version: z.number().int().positive(),
  status: z.literal("published"),
  publishedAt: IsoDateTimeSchema,
});

export const AdminDailySetVoidSchema = z.object({
  actorSubject: z.string().min(1).max(100),
  reason: z.string().min(1).max(500),
  voidedAt: IsoDateTimeSchema,
});

export const AdminVoidDailySetRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const AdminVoidDailySetResponseSchema = z.object({
  dailySetId: UuidSchema,
  void: AdminDailySetVoidSchema,
  replayed: z.boolean(),
});

export const AdminContentCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const AdminListQuestionRevisionsQuerySchema = z
  .object({
    status: ContentStatusSchema.optional(),
    cursor: AdminContentCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const AdminQuestionRevisionListItemSchema = z.object({
  revisionId: UuidSchema,
  questionId: UuidSchema,
  revisionNumber: z.number().int().positive(),
  prompt: z.string().min(1).max(500),
  choices: QuestionChoicesSchema,
  correctIndex: AnswerIndexSchema,
  explanation: z.string().min(1),
  sourceUrl: z.url(),
  sourceCheckedAt: IsoDateTimeSchema,
  category: CategorySchema,
  difficulty: DifficultySchema,
  status: ContentStatusSchema,
  reviewerId: z.string().min(1).max(100),
  timeSensitive: z.boolean(),
  validUntil: IsoDateTimeSchema.nullable(),
  nextReviewAt: IsoDateTimeSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  retiredAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const AdminListQuestionRevisionsResponseSchema = z.object({
  questionRevisions: z.array(AdminQuestionRevisionListItemSchema),
  nextCursor: AdminContentCursorSchema.nullable(),
});

export const AdminListDailySetsQuerySchema = z
  .object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    status: DailySetStatusSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    const from = Date.parse(`${query.from}T00:00:00.000Z`);
    const to = Date.parse(`${query.to}T00:00:00.000Z`);
    if (from > to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be on or after from",
      });
      return;
    }

    const inclusiveDays = (to - from) / 86_400_000 + 1;
    if (inclusiveDays > 90) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "date range must not exceed 90 days",
      });
    }
  });

export const AdminDailySetRevisionSummarySchema = z.object({
  revisionId: UuidSchema,
  questionId: UuidSchema,
  revisionNumber: z.number().int().positive(),
  prompt: z.string().min(1).max(500),
  category: CategorySchema,
  difficulty: DifficultySchema,
  status: ContentStatusSchema,
});

export const AdminDailySetListItemSchema = z.object({
  position: QuestionSequenceSchema,
  choiceOrder: ChoiceOrderSchema,
  revision: AdminDailySetRevisionSummarySchema,
});

export const AdminDailySetListEntrySchema = z.object({
  dailySetId: UuidSchema,
  quizDate: IsoDateSchema,
  version: z.number().int().positive(),
  status: DailySetStatusSchema,
  publishedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  void: AdminDailySetVoidSchema.nullable(),
  items: z.array(AdminDailySetListItemSchema).length(5),
});

export const AdminListDailySetsResponseSchema = z.object({
  dailySets: z.array(AdminDailySetListEntrySchema),
});

export const AdminAuditActionSchema = z.enum([
  "question_revision.create",
  "question_revision.status.update",
  "daily_set.create",
  "daily_set.publish",
  "daily_set.correct",
  "daily_set.void",
  "report.status.update",
]);

export const AdminAuditResourceTypeSchema = z.enum([
  "question_revision",
  "daily_set",
  "question_report",
]);

const REPORT_STATUS_VALUES = [
  "open",
  "reviewing",
  "resolved",
  "dismissed",
] as const;

export const AdminAuditMetadataSchema = z.object({
  action: AdminAuditActionSchema.optional(),
  status: ContentStatusSchema.optional(),
  category: CategorySchema.optional(),
  difficulty: DifficultySchema.optional(),
  reason: z.string().min(1).max(500).optional(),
  oldVersion: z.number().int().positive().optional(),
  newVersion: z.number().int().positive().optional(),
  oldItems: z.array(AdminDailySetDraftItemSchema).length(5).optional(),
  newItems: z.array(AdminDailySetDraftItemSchema).length(5).optional(),
  fromStatus: z.enum(REPORT_STATUS_VALUES).optional(),
  toStatus: z.enum(REPORT_STATUS_VALUES).optional(),
});

export const AdminListAuditLogsQuerySchema = z
  .object({
    cursor: AdminContentCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const AdminAuditLogListItemSchema = z.object({
  actorSubject: z.string().min(1).max(100),
  action: AdminAuditActionSchema,
  resourceType: AdminAuditResourceTypeSchema,
  resourceId: UuidSchema,
  metadata: AdminAuditMetadataSchema,
  createdAt: IsoDateTimeSchema,
});

export const AdminListAuditLogsResponseSchema = z.object({
  auditLogs: z.array(AdminAuditLogListItemSchema),
  nextCursor: AdminContentCursorSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const ReportReasonSchema = z.enum([
  "incorrect_answer",
  "ambiguous",
  "outdated",
  "inappropriate",
  "other",
]);
export const ReportStatusSchema = z.enum(REPORT_STATUS_VALUES);
export const ReportTriageStatusSchema = z.enum([
  "reviewing",
  "resolved",
  "dismissed",
]);

export const CreateQuestionReportRequestSchema = z.object({
  questionRevisionId: UuidSchema,
  reasonCode: ReportReasonSchema,
  detail: z.string().trim().min(1).max(500).optional(),
});

export const CreateReportResponseSchema = z.object({
  id: UuidSchema,
  deduplicated: z.boolean(),
  createdAt: IsoDateTimeSchema,
});

export const AdminListReportsQuerySchema = z
  .object({
    cursor: AdminContentCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: ReportStatusSchema.optional(),
    reasonCode: ReportReasonSchema.optional(),
  })
  .strict();

export const AdminReportListItemSchema = z
  .object({
    reportId: UuidSchema,
    questionRevisionId: UuidSchema.nullable(),
    challengeId: UuidSchema.nullable(),
    questionContext: z
      .object({
        questionId: UuidSchema,
        revisionId: UuidSchema,
        revisionNumber: z.number().int().positive(),
        prompt: z.string().min(1).max(500),
        category: CategorySchema,
        status: ContentStatusSchema,
      })
      .nullable(),
    reasonCode: ReportReasonSchema,
    detail: z.string().min(1).max(500).nullable(),
    createdAt: IsoDateTimeSchema,
    status: ReportStatusSchema,
    triagedBy: z.string().min(1).max(100).nullable(),
    triagedAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((report, context) => {
    if (
      (report.questionRevisionId === null) ===
      (report.challengeId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["questionRevisionId"],
        message: "exactly one report target is required",
      });
    }

    if (
      (report.questionRevisionId === null) !==
      (report.questionContext === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["questionContext"],
        message: "question context must match the report target",
      });
    } else if (
      report.questionContext !== null &&
      report.questionContext.revisionId !== report.questionRevisionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["questionContext", "revisionId"],
        message: "question context revision must match the report target",
      });
    }

    const hasTriageActor = report.triagedBy !== null;
    const hasTriageTime = report.triagedAt !== null;
    if (
      (report.status === "open" && (hasTriageActor || hasTriageTime)) ||
      (report.status !== "open" && (!hasTriageActor || !hasTriageTime))
    ) {
      context.addIssue({
        code: "custom",
        path: ["triagedBy"],
        message: "triage fields must match report status",
      });
    }
  });

export const AdminListReportsResponseSchema = z.object({
  reports: z.array(AdminReportListItemSchema),
  nextCursor: AdminContentCursorSchema.nullable(),
});

export const AdminUpdateReportStatusRequestSchema = z
  .object({
    status: ReportTriageStatusSchema,
  })
  .strict();

export const AdminUpdateReportStatusResponseSchema = z.object({
  reportId: UuidSchema,
  status: ReportTriageStatusSchema,
  triagedBy: z.string().min(1).max(100),
  triagedAt: IsoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

/** base64url(HMAC-SHA256) = 43 chars, no padding. */
export const ChallengeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ChallengeStatusSchema = z.enum([
  "open",
  "claimed",
  "completed",
  "expired",
]);
export const ChallengeViewerRoleSchema = z.enum([
  "creator",
  "opponent",
  "none",
]);
export const ChallengeOutcomeSchema = z.enum(["win", "loss", "draw"]);
export const NicknameSchema = z.string().min(1).max(12);
export const ScoreSchema = z.number().int().min(0).max(5);

export const CreateChallengeRequestSchema = z.object({
  attemptId: UuidSchema,
});

export const CreateChallengeResponseSchema = z.object({
  challenge: z.object({
    token: ChallengeTokenSchema,
    status: z.literal("open"),
    quizDate: IsoDateSchema,
    expiresAt: IsoDateTimeSchema,
    creatorScore: ScoreSchema,
  }),
});

export const ChallengeVoidProjectionSchema = z.object({
  status: z.literal("voided"),
  quizDate: IsoDateSchema,
  voidedAt: IsoDateTimeSchema,
  viewerRole: ChallengeViewerRoleSchema,
});

export const ChallengeLandingResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: ChallengeStatusSchema,
    quizDate: IsoDateSchema,
    expiresAt: IsoDateTimeSchema,
    creatorNickname: NicknameSchema,
    viewerRole: ChallengeViewerRoleSchema,
  }),
  ChallengeVoidProjectionSchema,
]);

export const ClaimChallengeResponseSchema = z.object({
  challenge: z.object({
    status: z.enum(["claimed", "completed"]),
    quizDate: IsoDateSchema,
    expiresAt: IsoDateTimeSchema,
  }),
  daily: DailyAvailableStartResponseSchema,
});

export const ChallengeResultVoidProjectionSchema =
  ChallengeVoidProjectionSchema.extend({
    viewerRole: z.enum(["creator", "opponent"]),
  });

export const ChallengeResultResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["open", "claimed"]),
    quizDate: IsoDateSchema,
    expiresAt: IsoDateTimeSchema,
    viewerRole: z.enum(["creator", "opponent"]),
    me: z.object({ nickname: NicknameSchema, score: ScoreSchema.nullable() }),
    opponent: z.object({
      nickname: NicknameSchema.nullable(),
      completed: z.literal(false),
    }),
  }),
  z.object({
    status: z.literal("completed"),
    quizDate: IsoDateSchema,
    completedAt: IsoDateTimeSchema,
    viewerRole: z.enum(["creator", "opponent"]),
    outcome: ChallengeOutcomeSchema,
    me: z.object({ nickname: NicknameSchema, score: ScoreSchema }),
    opponent: z.object({ nickname: NicknameSchema, score: ScoreSchema }),
  }),
  z.object({
    status: z.literal("redacted"),
    quizDate: IsoDateSchema,
    viewerRole: z.enum(["creator", "opponent"]),
    me: z.object({ nickname: NicknameSchema, score: ScoreSchema.nullable() }),
  }),
  ChallengeResultVoidProjectionSchema,
]);

export type ChallengeStatus = z.infer<typeof ChallengeStatusSchema>;
export type ChallengeViewerRole = z.infer<typeof ChallengeViewerRoleSchema>;
export type ChallengeOutcome = z.infer<typeof ChallengeOutcomeSchema>;
export type ChallengeVoidProjection = z.infer<
  typeof ChallengeVoidProjectionSchema
>;
export type ChallengeResultVoidProjection = z.infer<
  typeof ChallengeResultVoidProjectionSchema
>;
export type CreateChallengeRequest = z.infer<
  typeof CreateChallengeRequestSchema
>;
export type CreateChallengeResponse = z.infer<
  typeof CreateChallengeResponseSchema
>;
export type ChallengeLandingResponse = z.infer<
  typeof ChallengeLandingResponseSchema
>;
export type ClaimChallengeResponse = z.infer<
  typeof ClaimChallengeResponseSchema
>;
export type ChallengeResultResponse = z.infer<
  typeof ChallengeResultResponseSchema
>;

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
export type OperationalCapabilitiesResponse = z.infer<
  typeof OperationalCapabilitiesResponseSchema
>;
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
export type UpdateResultNotificationPreferenceRequest = z.infer<
  typeof UpdateResultNotificationPreferenceRequestSchema
>;
export type ResultNotificationPreferenceResponse = z.infer<
  typeof ResultNotificationPreferenceResponseSchema
>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type PublicQuestion = z.infer<typeof PublicQuestionSchema>;
export type SavedAnswer = z.infer<typeof SavedAnswerSchema>;
export type DailyAvailableStartResponse = z.infer<
  typeof DailyAvailableStartResponseSchema
>;
export type DailyVoidProjection = z.infer<typeof DailyVoidProjectionSchema>;
export type DailyStartResponse = z.infer<typeof DailyStartResponseSchema>;
export type CompleteAttemptRequest = z.infer<
  typeof CompleteAttemptRequestSchema
>;
export type QuizReviewItem = z.infer<typeof QuizReviewItemSchema>;
export type CompletedAttemptResponse = z.infer<
  typeof CompletedAttemptResponseSchema
>;
export type VoidedAttemptResponse = z.infer<typeof VoidedAttemptResponseSchema>;
export type CompleteAttemptResponse = z.infer<
  typeof CompleteAttemptResponseSchema
>;
export type Difficulty = z.infer<typeof DifficultySchema>;
export type Category = z.infer<typeof CategorySchema>;
export type ContentStatus = z.infer<typeof ContentStatusSchema>;
export type DailySetStatus = z.infer<typeof DailySetStatusSchema>;
export type QuestionChoices = z.infer<typeof QuestionChoicesSchema>;
export type ChoiceOrder = z.infer<typeof ChoiceOrderSchema>;
export type AdminCreateQuestionRevisionRequest = z.infer<
  typeof AdminCreateQuestionRevisionRequestSchema
>;
export type AdminCreateQuestionRevisionResponse = z.infer<
  typeof AdminCreateQuestionRevisionResponseSchema
>;
export type AdminUpdateQuestionRevisionStatusRequest = z.infer<
  typeof AdminUpdateQuestionRevisionStatusRequestSchema
>;
export type AdminUpdateQuestionRevisionStatusResponse = z.infer<
  typeof AdminUpdateQuestionRevisionStatusResponseSchema
>;
export type AdminDailySetDraftItem = z.infer<
  typeof AdminDailySetDraftItemSchema
>;
export type AdminCreateDailySetDraftRequest = z.infer<
  typeof AdminCreateDailySetDraftRequestSchema
>;
export type AdminCreateDailySetDraftResponse = z.infer<
  typeof AdminCreateDailySetDraftResponseSchema
>;
export type AdminPublishDailySetResponse = z.infer<
  typeof AdminPublishDailySetResponseSchema
>;
export type AdminDailySetVoid = z.infer<typeof AdminDailySetVoidSchema>;
export type AdminVoidDailySetRequest = z.infer<
  typeof AdminVoidDailySetRequestSchema
>;
export type AdminVoidDailySetResponse = z.infer<
  typeof AdminVoidDailySetResponseSchema
>;
export type AdminContentCursor = z.infer<typeof AdminContentCursorSchema>;
export type AdminListQuestionRevisionsQuery = z.infer<
  typeof AdminListQuestionRevisionsQuerySchema
>;
export type AdminQuestionRevisionListItem = z.infer<
  typeof AdminQuestionRevisionListItemSchema
>;
export type AdminListQuestionRevisionsResponse = z.infer<
  typeof AdminListQuestionRevisionsResponseSchema
>;
export type AdminListDailySetsQuery = z.infer<
  typeof AdminListDailySetsQuerySchema
>;
export type AdminDailySetRevisionSummary = z.infer<
  typeof AdminDailySetRevisionSummarySchema
>;
export type AdminDailySetListItem = z.infer<typeof AdminDailySetListItemSchema>;
export type AdminDailySetListEntry = z.infer<
  typeof AdminDailySetListEntrySchema
>;
export type AdminListDailySetsResponse = z.infer<
  typeof AdminListDailySetsResponseSchema
>;
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;
export type AdminAuditResourceType = z.infer<
  typeof AdminAuditResourceTypeSchema
>;
export type AdminAuditMetadata = z.infer<typeof AdminAuditMetadataSchema>;
export type AdminListAuditLogsQuery = z.infer<
  typeof AdminListAuditLogsQuerySchema
>;
export type AdminAuditLogListItem = z.infer<typeof AdminAuditLogListItemSchema>;
export type AdminListAuditLogsResponse = z.infer<
  typeof AdminListAuditLogsResponseSchema
>;
export type ReportReason = z.infer<typeof ReportReasonSchema>;
export type ReportStatus = z.infer<typeof ReportStatusSchema>;
export type ReportTriageStatus = z.infer<typeof ReportTriageStatusSchema>;
export type CreateQuestionReportRequest = z.infer<
  typeof CreateQuestionReportRequestSchema
>;
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;
export type AdminListReportsQuery = z.infer<typeof AdminListReportsQuerySchema>;
export type AdminReportListItem = z.infer<typeof AdminReportListItemSchema>;
export type AdminListReportsResponse = z.infer<
  typeof AdminListReportsResponseSchema
>;
export type AdminUpdateReportStatusRequest = z.infer<
  typeof AdminUpdateReportStatusRequestSchema
>;
export type AdminUpdateReportStatusResponse = z.infer<
  typeof AdminUpdateReportStatusResponseSchema
>;
