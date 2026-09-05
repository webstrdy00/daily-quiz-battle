import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
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

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

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
export const challengeStatus = pgEnum("challenge_status", [
  "open",
  "claimed",
  "completed",
  "expired",
]);
export const notificationEventType = pgEnum("notification_event_type", [
  "challenge.completed",
]);
export const notificationOutboxStatus = pgEnum("notification_outbox_status", [
  "pending",
  "published",
  "failed",
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
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
      "users_deleted_at_ck",
      sql`(
        (${table.identityStatus} = 'deleted' and ${table.deletedAt} is not null)
        or (${table.identityStatus} in ('active', 'blocked') and ${table.deletedAt} is null)
      )`,
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
    timeSensitive: boolean("time_sensitive").notNull().default(false),
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
      "question_revisions_category_canonical_ck",
      sql`char_length(${table.category}) > 0
        and ${table.category} = lower(btrim(${table.category}))`,
    ),
    check(
      "question_revisions_choices_ck",
      sql`jsonb_typeof(${table.choices}) = 'array'
        and jsonb_array_length(${table.choices}) = 4
        and jsonb_typeof(${table.choices} -> 0) = 'string'
        and char_length(btrim(${table.choices} ->> 0)) > 0
        and jsonb_typeof(${table.choices} -> 1) = 'string'
        and char_length(btrim(${table.choices} ->> 1)) > 0
        and jsonb_typeof(${table.choices} -> 2) = 'string'
        and char_length(btrim(${table.choices} ->> 2)) > 0
        and jsonb_typeof(${table.choices} -> 3) = 'string'
        and char_length(btrim(${table.choices} ->> 3)) > 0`,
    ),
    check(
      "question_revisions_correct_index_ck",
      sql`${table.correctIndex} between 0 and 3`,
    ),
    check(
      "question_revisions_prompt_length_ck",
      sql`char_length(${table.prompt}) between 1 and 500`,
    ),
    check(
      "question_revisions_time_sensitive_ck",
      sql`not ${table.timeSensitive}
        or (
          ${table.validUntil} is not null
          and ${table.nextReviewAt} is not null
          and ${table.validUntil} > ${table.sourceCheckedAt}
        )`,
    ),
    check(
      "question_revisions_published_at_ck",
      sql`${table.lifecycleStatus} <> 'published' or ${table.publishedAt} is not null`,
    ),
    check(
      "question_revisions_retired_at_ck",
      sql`${table.lifecycleStatus} <> 'retired' or ${table.retiredAt} is not null`,
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

export const dailySetVoids = pgTable(
  "daily_set_voids",
  {
    dailySetId: uuid("daily_set_id")
      .primaryKey()
      .references(() => dailySets.id, { onDelete: "restrict" }),
    actorSubject: varchar("actor_subject", { length: 100 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "daily_set_voids_actor_subject_ck",
      sql`char_length(btrim(${table.actorSubject})) between 1 and 100
        and ${table.actorSubject} = btrim(${table.actorSubject})`,
    ),
    check(
      "daily_set_voids_reason_ck",
      sql`char_length(btrim(${table.reason})) between 1 and 500
        and ${table.reason} = btrim(${table.reason})`,
    ),
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
      sql`jsonb_typeof(${table.choiceOrder}) = 'array' and jsonb_array_length(${table.choiceOrder}) = 4 and ${table.choiceOrder} @> '[0, 1, 2, 3]'::jsonb`,
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
    challengeId: uuid("challenge_id").references(
      (): AnyPgColumn => challenges.id,
      { onDelete: "set null" },
    ),
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
    index("attempts_challenge_id_idx").on(table.challengeId),
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

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    publicTokenHash: varchar("public_token_hash", { length: 64 }).notNull(),
    dailySetId: uuid("daily_set_id")
      .notNull()
      .references(() => dailySets.id, { onDelete: "restrict" }),
    creatorUserId: uuid("creator_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    creatorAttemptId: uuid("creator_attempt_id").references(() => attempts.id, {
      onDelete: "set null",
    }),
    creatorScore: smallint("creator_score"),
    creatorNicknameSnapshot: varchar("creator_nickname_snapshot", {
      length: 20,
    }),
    claimedByUserId: uuid("claimed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    opponentAttemptId: uuid("opponent_attempt_id").references(
      () => attempts.id,
      { onDelete: "set null" },
    ),
    opponentScore: smallint("opponent_score"),
    opponentNicknameSnapshot: varchar("opponent_nickname_snapshot", {
      length: 20,
    }),
    status: challengeStatus("status").notNull().default("open"),
    source: varchar("source", { length: 32 }).notNull().default("share_link"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resultRedactedAt: timestamp("result_redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("challenges_public_token_hash_uq").on(table.publicTokenHash),
    index("challenges_daily_set_id_idx").on(table.dailySetId),
    index("challenges_creator_attempt_status_idx").on(
      table.creatorAttemptId,
      table.status,
    ),
    index("challenges_expires_status_idx").on(table.expiresAt, table.status),
    check(
      "challenges_creator_score_ck",
      sql`${table.creatorScore} is null or ${table.creatorScore} between 0 and 5`,
    ),
    check(
      "challenges_opponent_score_ck",
      sql`${table.opponentScore} is null or ${table.opponentScore} between 0 and 5`,
    ),
    check(
      "challenges_expires_after_created_ck",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "challenges_distinct_participants_ck",
      sql`${table.creatorUserId} is null or ${table.claimedByUserId} is null or ${table.creatorUserId} <> ${table.claimedByUserId}`,
    ),
  ],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "restrict" }),
    resultEnabled: boolean("result_enabled").notNull().default(false),
    encryptedAnonymousKey: bytea("encrypted_anon_key"),
    iv: bytea("iv"),
    authTag: bytea("auth_tag"),
    keyVersion: integer("key_version"),
    agreedAt: timestamp("agreed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "notification_preferences_key_version_ck",
      sql`${table.keyVersion} is null or ${table.keyVersion} > 0`,
    ),
    check(
      "notification_preferences_state_ck",
      sql`(
        ${table.resultEnabled}
        and ${table.encryptedAnonymousKey} is not null
        and ${table.iv} is not null
        and ${table.authTag} is not null
        and ${table.keyVersion} is not null
        and ${table.agreedAt} is not null
        and ${table.revokedAt} is null
      ) or (
        not ${table.resultEnabled}
        and ${table.encryptedAnonymousKey} is null
        and ${table.iv} is null
        and ${table.authTag} is null
      )`,
    ),
  ],
);

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: notificationEventType("event_type").notNull(),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "restrict" }),
    dedupeKey: text("dedupe_key").notNull(),
    status: notificationOutboxStatus("status").notNull().default("pending"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: varchar("last_error", { length: 500 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("notification_outbox_dedupe_key_uq").on(table.dedupeKey),
    index("notification_outbox_pending_available_at_idx")
      .on(table.availableAt, table.occurredAt)
      .where(sql`${table.status} = 'pending'`),
    index("notification_outbox_pending_challenge_id_idx")
      .on(table.challengeId)
      .where(sql`${table.status} = 'pending'`),
    check(
      "notification_outbox_attempt_count_ck",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export const operationTaskRuns = pgTable(
  "operation_task_runs",
  {
    taskName: text("task_name").primaryKey(),
    lastStartedAt: timestamp("last_started_at", {
      withTimezone: true,
    }).notNull(),
    lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastDurationMs: integer("last_duration_ms").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "operation_task_runs_task_name_ck",
      sql`${table.taskName} in ('cleanup', 'notification_worker')`,
    ),
    check(
      "operation_task_runs_consecutive_failures_ck",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "operation_task_runs_last_duration_ms_ck",
      sql`${table.lastDurationMs} >= 0`,
    ),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    questionRevisionId: uuid("question_revision_id").references(
      () => questionRevisions.id,
      { onDelete: "restrict" },
    ),
    challengeId: uuid("challenge_id"),
    reasonCode: varchar("reason_code", { length: 32 }).notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dedupeWindowStart: timestamp("dedupe_window_start", {
      withTimezone: true,
    }).generatedAlwaysAs(
      sql`date_bin(interval '10 minutes', "created_at", timestamptz '1970-01-01 00:00:00+00')`,
    ),
  },
  (table) => [
    uniqueIndex("reports_question_dedupe_uq")
      .on(
        table.reporterUserId,
        table.questionRevisionId,
        table.reasonCode,
        table.dedupeWindowStart,
      )
      .where(sql`${table.questionRevisionId} is not null`),
    index("reports_question_revision_created_at_idx")
      .on(table.questionRevisionId, table.createdAt.desc())
      .where(sql`${table.questionRevisionId} is not null`),
    index("reports_challenge_created_at_idx")
      .on(table.challengeId, table.createdAt.desc())
      .where(sql`${table.challengeId} is not null`),
    check(
      "reports_target_xor_ck",
      sql`num_nonnulls(${table.questionRevisionId}, ${table.challengeId}) = 1`,
    ),
    check(
      "reports_reason_code_ck",
      sql`${table.reasonCode} in ('incorrect_answer', 'ambiguous', 'outdated', 'inappropriate', 'other')`,
    ),
    check(
      "reports_detail_length_ck",
      sql`${table.detail} is null or char_length(${table.detail}) between 1 and 500`,
    ),
  ],
);

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorSubject: varchar("actor_subject", { length: 100 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    resourceType: varchar("resource_type", { length: 32 }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_audit_logs_resource_time_idx").on(
      table.resourceType,
      table.resourceId,
      table.createdAt.desc(),
    ),
    check(
      "admin_audit_logs_metadata_object_ck",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
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
