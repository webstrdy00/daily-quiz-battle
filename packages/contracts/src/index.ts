import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const IsoDateSchema = z.iso.date();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const AnswerIndexSchema = z.number().int().min(0).max(3);
export const QuestionSequenceSchema = z.number().int().min(1).max(5);
export const DifficultySchema = z.enum(["easy", "medium", "hard"]);
export const ContentStatusSchema = z.enum([
  "draft",
  "review",
  "approved",
  "published",
  "retired",
]);
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
    nickname: z.string().min(1).max(12),
  }),
});

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

export const DailyStartResponseSchema = z.object({
  attempt: z.object({
    id: UuidSchema,
    status: AttemptStatusSchema,
    quizDate: IsoDateSchema,
    answeredCount: z.number().int().min(0).max(5),
    score: z.number().int().min(0).max(5).nullable(),
    answers: z.array(SavedAnswerSchema).max(5),
  }),
  questions: z.array(PublicQuestionSchema).length(5),
});

export const SubmitAnswerRequestSchema = z.object({
  sequence: QuestionSequenceSchema,
  questionRevisionId: UuidSchema,
  selectedIndex: AnswerIndexSchema,
});

export const SubmitAnswerResponseSchema = z.object({
  attemptId: UuidSchema,
  sequence: QuestionSequenceSchema,
  saved: z.literal(true),
  answeredCount: z.number().int().min(1).max(5),
  nextSequence: QuestionSequenceSchema.nullable(),
});

export const QuizReviewItemSchema = z.object({
  sequence: QuestionSequenceSchema,
  prompt: z.string().min(1),
  selectedIndex: AnswerIndexSchema,
  correctIndex: AnswerIndexSchema,
  correct: z.boolean(),
  explanation: z.string().min(1),
});

export const CompleteAttemptResponseSchema = z.object({
  attemptId: UuidSchema,
  status: z.literal("completed"),
  score: z.number().int().min(0).max(5),
  total: z.literal(5),
  completedAt: IsoDateTimeSchema,
  review: z.array(QuizReviewItemSchema).length(5),
});

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
    category: z.string().trim().toLowerCase().min(1).max(32),
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

export const ChallengeLandingResponseSchema = z.object({
  status: ChallengeStatusSchema,
  quizDate: IsoDateSchema,
  expiresAt: IsoDateTimeSchema,
  creatorNickname: NicknameSchema,
  viewerRole: ChallengeViewerRoleSchema,
});

export const ClaimChallengeResponseSchema = z.object({
  challenge: z.object({
    status: z.enum(["claimed", "completed"]),
    quizDate: IsoDateSchema,
    expiresAt: IsoDateTimeSchema,
  }),
  daily: DailyStartResponseSchema,
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
]);

export type ChallengeStatus = z.infer<typeof ChallengeStatusSchema>;
export type ChallengeViewerRole = z.infer<typeof ChallengeViewerRoleSchema>;
export type ChallengeOutcome = z.infer<typeof ChallengeOutcomeSchema>;
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
export type DailyStartResponse = z.infer<typeof DailyStartResponseSchema>;
export type SubmitAnswerRequest = z.infer<typeof SubmitAnswerRequestSchema>;
export type SubmitAnswerResponse = z.infer<typeof SubmitAnswerResponseSchema>;
export type QuizReviewItem = z.infer<typeof QuizReviewItemSchema>;
export type CompleteAttemptResponse = z.infer<
  typeof CompleteAttemptResponseSchema
>;
export type Difficulty = z.infer<typeof DifficultySchema>;
export type ContentStatus = z.infer<typeof ContentStatusSchema>;
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
export type ReportReason = z.infer<typeof ReportReasonSchema>;
export type CreateQuestionReportRequest = z.infer<
  typeof CreateQuestionReportRequestSchema
>;
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;
