import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const AnswerIndexSchema = z.number().int().min(0).max(3);
export const QuestionSequenceSchema = z.number().int().min(1).max(5);
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

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
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
