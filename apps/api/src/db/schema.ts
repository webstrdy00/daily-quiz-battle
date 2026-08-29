import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const identityStatus = pgEnum("identity_status", [
  "active",
  "deleted",
  "blocked",
]);
export const contentStatus = pgEnum("content_status", [
  "draft",
  "review",
  "approved",
  "published",
  "retired",
]);
export const difficulty = pgEnum("difficulty", ["easy", "medium", "hard"]);
export const dailySetStatus = pgEnum("daily_set_status", [
  "draft",
  "published",
  "retired",
]);
export const attemptStatus = pgEnum("attempt_status", [
  "started",
  "completed",
  "abandoned",
]);
export const idempotencyStatus = pgEnum("idempotency_status", [
  "processing",
  "completed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    anonymousKeyFingerprint: varchar("anon_key_fingerprint", {
      length: 64,
    }).notNull(),
    nickname: varchar("nickname", { length: 20 })
      .notNull()
      .default("익명 도전자"),
    identityStatus: identityStatus("identity_status")
      .notNull()
      .default("active"),
    identityVerifiedAt: timestamp("identity_verified_at", {
      withTimezone: true,
    }).notNull(),
    tokenVersion: integer("token_version").notNull().default(1),
    streakDays: integer("streak_days").notNull().default(0),
    lastDailyDate: date("last_daily_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_anon_key_fingerprint_uq").on(
      table.anonymousKeyFingerprint,
    ),
    check(
      "users_nickname_length_ck",
      sql`char_length(${table.nickname}) between 1 and 12`,
    ),
    check("users_token_version_ck", sql`${table.tokenVersion} > 0`),
    check("users_streak_days_ck", sql`${table.streakDays} >= 0`),
  ],
);

export const questions = pgTable("questions", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const questionRevisions = pgTable(
  "question_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    category: varchar("category", { length: 32 }).notNull(),
    difficulty: difficulty("difficulty").notNull(),
    prompt: text("prompt").notNull(),
    choices: jsonb("choices")
      .$type<[string, string, string, string]>()
      .notNull(),
    correctIndex: smallint("correct_index").notNull(),
    explanation: text("explanation").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceCheckedAt: timestamp("source_checked_at", {
      withTimezone: true,
    }).notNull(),
    reviewerId: varchar("reviewer_id", { length: 100 }).notNull(),
    lifecycleStatus: contentStatus("lifecycle_status")
      .notNull()
      .default("draft"),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("question_revisions_question_revision_uq").on(
      table.questionId,
      table.revisionNumber,
    ),
    check(
      "question_revisions_revision_number_ck",
      sql`${table.revisionNumber} > 0`,
    ),
    check(
      "question_revisions_choices_ck",
      sql`jsonb_typeof(${table.choices}) = 'array' and jsonb_array_length(${table.choices}) = 4`,
    ),
    check(
      "question_revisions_correct_index_ck",
      sql`${table.correctIndex} between 0 and 3`,
    ),
    check(
      "question_revisions_prompt_length_ck",
      sql`char_length(${table.prompt}) between 1 and 500`,
    ),
  ],
);

export const dailySets = pgTable(
  "daily_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quizDate: date("quiz_date", { mode: "string" }).notNull(),
    version: integer("version").notNull().default(1),
    status: dailySetStatus("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("daily_sets_quiz_date_uq").on(table.quizDate),
    check("daily_sets_version_ck", sql`${table.version} > 0`),
  ],
);

export const dailySetItems = pgTable(
  "daily_set_items",
  {
    dailySetId: uuid("daily_set_id")
      .notNull()
      .references(() => dailySets.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "restrict" }),
    choiceOrder: jsonb("choice_order")
      .$type<[number, number, number, number]>()
      .notNull()
      .default([0, 1, 2, 3]),
  },
  (table) => [
    primaryKey({
      name: "daily_set_items_pk",
      columns: [table.dailySetId, table.position],
    }),
    uniqueIndex("daily_set_items_revision_uq").on(
      table.dailySetId,
      table.questionRevisionId,
    ),
    check(
      "daily_set_items_position_ck",
      sql`${table.position} between 1 and 5`,
    ),
    check(
      "daily_set_items_choice_order_ck",
      sql`jsonb_typeof(${table.choiceOrder}) = 'array' and jsonb_array_length(${table.choiceOrder}) = 4`,
    ),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    dailySetId: uuid("daily_set_id")
      .notNull()
      .references(() => dailySets.id, { onDelete: "restrict" }),
    status: attemptStatus("status").notNull().default("started"),
    score: smallint("score"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("attempts_user_daily_set_uq").on(
      table.userId,
      table.dailySetId,
    ),
    index("attempts_status_started_at_idx").on(table.status, table.startedAt),
    check("attempts_score_ck", sql`${table.score} between 0 and 5`),
    check(
      "attempts_state_ck",
      sql`(
        (${table.status} = 'started' and ${table.score} is null and ${table.completedAt} is null and ${table.abandonedAt} is null)
        or (${table.status} = 'completed' and ${table.score} is not null and ${table.completedAt} is not null and ${table.abandonedAt} is null)
        or (${table.status} = 'abandoned' and ${table.score} is null and ${table.completedAt} is null and ${table.abandonedAt} is not null)
      )`,
    ),
  ],
);

export const attemptAnswers = pgTable(
  "attempt_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    sequence: smallint("sequence").notNull(),
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "restrict" }),
    selectedIndex: smallint("selected_index").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("attempt_answers_attempt_sequence_uq").on(
      table.attemptId,
      table.sequence,
    ),
    uniqueIndex("attempt_answers_attempt_revision_uq").on(
      table.attemptId,
      table.questionRevisionId,
    ),
    check(
      "attempt_answers_sequence_ck",
      sql`${table.sequence} between 1 and 5`,
    ),
    check(
      "attempt_answers_selected_index_ck",
      sql`${table.selectedIndex} between 0 and 3`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operation: varchar("operation", { length: 120 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    status: idempotencyStatus("status").notNull().default("processing"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    resourceId: uuid("resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_records_scope_uq").on(
      table.userId,
      table.operation,
      table.keyHash,
    ),
    index("idempotency_records_expires_at_idx").on(table.expiresAt),
    check(
      "idempotency_records_response_status_ck",
      sql`${table.responseStatus} is null or ${table.responseStatus} between 200 and 599`,
    ),
  ],
);
