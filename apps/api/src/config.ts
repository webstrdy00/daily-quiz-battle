import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

const LOCAL_DATABASE_URL =
  "postgres://daily_quiz:daily_quiz_local@localhost:5432/daily_quiz";
const LOCAL_PEPPER = "local-only-anon-key-pepper-change-before-production-2026";
const LOCAL_TOKEN_SECRET =
  "local-only-access-token-secret-change-before-production-2026";
const LOCAL_ADMIN_TOKEN_SECRET =
  "local-only-admin-access-token-secret-change-before-production-2026";
const LOCAL_CHALLENGE_TOKEN_SECRET =
  "local-only-challenge-token-secret-change-before-production-2026";
const LOCAL_NOTIFICATION_TARGET_ENCRYPTION_KEY =
  "bG9jYWwtbm90aWZpY2F0aW9uLWtleS0zMi1ieXRlcyE=";
const DEFAULT_NOTIFICATION_SEND_URL =
  "https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message";

const NotificationEncryptionKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9+/]{43}=$/,
    "notification target encryption key must be a base64-encoded 32-byte key",
  )
  .refine(
    (value) => Buffer.from(value, "base64").byteLength === 32,
    "notification target encryption key must decode to exactly 32 bytes",
  );

let localEnvironmentLoaded = false;

function loadLocalEnvironment(): void {
  if (localEnvironmentLoaded) {
    return;
  }

  localEnvironmentLoaded = true;

  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadEnvFile(candidate);
      return;
    }
  }
}

const EnvironmentSchema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().url().default(LOCAL_DATABASE_URL),
  IDENTITY_VERIFICATION_MODE: z.enum(["mock", "mtls"]).default("mock"),
  IDENTITY_VERIFY_URL: z
    .string()
    .url()
    .default(
      "https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/users/anon-key/verify",
    ),
  IDENTITY_MTLS_CERT: z.string().optional(),
  IDENTITY_MTLS_KEY: z.string().optional(),
  IDENTITY_MTLS_CA: z.string().optional(),
  ANON_KEY_PEPPER: z.string().min(32).default(LOCAL_PEPPER),
  ACCESS_TOKEN_SECRET: z.string().min(32).default(LOCAL_TOKEN_SECRET),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(3600)
    .default(1800),
  ACCESS_TOKEN_ISSUER: z.string().min(1).default("daily-quiz-battle-api"),
  ACCESS_TOKEN_AUDIENCE: z.string().min(1).default("daily-quiz-battle-web"),
  ADMIN_ACCESS_TOKEN_SECRET: z
    .string()
    .min(32)
    .default(LOCAL_ADMIN_TOKEN_SECRET),
  ADMIN_ACCESS_TOKEN_ISSUER: z
    .string()
    .min(1)
    .default("daily-quiz-battle-admin"),
  ADMIN_ACCESS_TOKEN_AUDIENCE: z
    .string()
    .min(1)
    .default("daily-quiz-battle-content-api"),
  CHALLENGE_TOKEN_SECRET: z
    .string()
    .min(32)
    .default(LOCAL_CHALLENGE_TOKEN_SECRET),
  CHALLENGE_TOKEN_SECRET_PREVIOUS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  NOTIFICATION_TARGET_ENCRYPTION_KEY: NotificationEncryptionKeySchema.default(
    LOCAL_NOTIFICATION_TARGET_ENCRYPTION_KEY,
  ),
  NOTIFICATION_TARGET_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  NOTIFICATION_TARGET_ENCRYPTION_KEY_PREVIOUS: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    NotificationEncryptionKeySchema.optional(),
  ),
  NOTIFICATION_TARGET_ENCRYPTION_KEY_VERSION_PREVIOUS: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.coerce.number().int().positive().optional(),
  ),
  RESULT_NOTIFICATION_TEMPLATE_SET_CODE: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1).optional(),
  ),
  NOTIFICATION_SEND_URL: z
    .string()
    .url()
    .default(DEFAULT_NOTIFICATION_SEND_URL),
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173"),
});

export type AppEnvironment = "development" | "staging" | "production";
export type IdentityVerificationMode = "mock" | "mtls";

export interface AppConfig {
  appEnvironment: AppEnvironment;
  apiHost: string;
  apiPort: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  identityVerificationMode: IdentityVerificationMode;
  identityVerifyUrl: string;
  identityMtlsCert?: string;
  identityMtlsKey?: string;
  identityMtlsCa?: string;
  anonymousKeyPepper: string;
  accessTokenSecret: string;
  accessTokenTtlSeconds: number;
  accessTokenIssuer: string;
  accessTokenAudience: string;
  adminAccessTokenSecret: string;
  adminAccessTokenIssuer: string;
  adminAccessTokenAudience: string;
  challengeTokenSecret: string;
  challengeTokenSecretPrevious?: string;
  notificationTargetEncryptionKey: Buffer;
  notificationTargetEncryptionKeyVersion: number;
  notificationTargetEncryptionKeyPrevious?: Buffer;
  notificationTargetEncryptionKeyVersionPrevious?: number;
  resultNotificationTemplateSetCode?: string;
  notificationSendUrl: string;
  rateLimitEnabled: boolean;
  allowedOrigins: string[];
}

export function loadConfig(): AppConfig {
  loadLocalEnvironment();
  const values = EnvironmentSchema.parse(process.env);
  const allowedOrigins = values.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    throw new Error("ALLOWED_ORIGINS must contain exact origins, not wildcard");
  }

  if (
    values.APP_ENV !== "development" &&
    values.IDENTITY_VERIFICATION_MODE === "mock"
  ) {
    throw new Error("Mock identity verification is development-only");
  }

  if (values.IDENTITY_VERIFICATION_MODE === "mtls") {
    if (!values.IDENTITY_MTLS_CERT || !values.IDENTITY_MTLS_KEY) {
      throw new Error(
        "mTLS identity verification requires certificate and key",
      );
    }
  }

  const hasPreviousNotificationKey =
    values.NOTIFICATION_TARGET_ENCRYPTION_KEY_PREVIOUS !== undefined;
  const hasPreviousNotificationKeyVersion =
    values.NOTIFICATION_TARGET_ENCRYPTION_KEY_VERSION_PREVIOUS !== undefined;

  if (hasPreviousNotificationKey !== hasPreviousNotificationKeyVersion) {
    throw new Error(
      "Previous notification target encryption key and version must be configured together",
    );
  }

  if (
    values.NOTIFICATION_TARGET_ENCRYPTION_KEY_VERSION_PREVIOUS ===
    values.NOTIFICATION_TARGET_ENCRYPTION_KEY_VERSION
  ) {
    throw new Error(
      "Previous notification target encryption key version must differ from the current version",
    );
  }

  if (values.APP_ENV !== "development") {
    if (values.ANON_KEY_PEPPER === LOCAL_PEPPER) {
      throw new Error(
        "Non-development ANON_KEY_PEPPER must not use the local default",
      );
    }

    if (values.ACCESS_TOKEN_SECRET === LOCAL_TOKEN_SECRET) {
      throw new Error(
        "Non-development ACCESS_TOKEN_SECRET must not use the local default",
      );
    }

    if (values.ADMIN_ACCESS_TOKEN_SECRET === LOCAL_ADMIN_TOKEN_SECRET) {
      throw new Error(
        "Non-development ADMIN_ACCESS_TOKEN_SECRET must not use the local default",
      );
    }

    if (values.CHALLENGE_TOKEN_SECRET === LOCAL_CHALLENGE_TOKEN_SECRET) {
      throw new Error(
        "Non-development CHALLENGE_TOKEN_SECRET must not use the local default",
      );
    }

    if (
      values.CHALLENGE_TOKEN_SECRET_PREVIOUS === LOCAL_CHALLENGE_TOKEN_SECRET
    ) {
      throw new Error(
        "Non-development CHALLENGE_TOKEN_SECRET_PREVIOUS must not use the local default",
      );
    }

    if (
      values.NOTIFICATION_TARGET_ENCRYPTION_KEY ===
      LOCAL_NOTIFICATION_TARGET_ENCRYPTION_KEY
    ) {
      throw new Error(
        "Non-development NOTIFICATION_TARGET_ENCRYPTION_KEY must not use the local default",
      );
    }

    if (
      values.NOTIFICATION_TARGET_ENCRYPTION_KEY_PREVIOUS ===
      LOCAL_NOTIFICATION_TARGET_ENCRYPTION_KEY
    ) {
      throw new Error(
        "Non-development NOTIFICATION_TARGET_ENCRYPTION_KEY_PREVIOUS must not use the local default",
      );
    }

    if (!values.RESULT_NOTIFICATION_TEMPLATE_SET_CODE) {
      throw new Error(
        "Non-development RESULT_NOTIFICATION_TEMPLATE_SET_CODE is required",
      );
    }
  }

  if (values.APP_ENV === "production") {
    if (!values.RATE_LIMIT_ENABLED) {
      throw new Error("Rate limiting cannot be disabled in production");
    }
  }

  return {
    appEnvironment: values.APP_ENV,
    apiHost: values.API_HOST,
    apiPort: values.API_PORT,
    logLevel: values.LOG_LEVEL,
    databaseUrl: values.DATABASE_URL,
    identityVerificationMode: values.IDENTITY_VERIFICATION_MODE,
    identityVerifyUrl: values.IDENTITY_VERIFY_URL,
    identityMtlsCert: values.IDENTITY_MTLS_CERT,
    identityMtlsKey: values.IDENTITY_MTLS_KEY,
    identityMtlsCa: values.IDENTITY_MTLS_CA,
    anonymousKeyPepper: values.ANON_KEY_PEPPER,
    accessTokenSecret: values.ACCESS_TOKEN_SECRET,
    accessTokenTtlSeconds: values.ACCESS_TOKEN_TTL_SECONDS,
    accessTokenIssuer: values.ACCESS_TOKEN_ISSUER,
    accessTokenAudience: values.ACCESS_TOKEN_AUDIENCE,
    adminAccessTokenSecret: values.ADMIN_ACCESS_TOKEN_SECRET,
    adminAccessTokenIssuer: values.ADMIN_ACCESS_TOKEN_ISSUER,
    adminAccessTokenAudience: values.ADMIN_ACCESS_TOKEN_AUDIENCE,
    challengeTokenSecret: values.CHALLENGE_TOKEN_SECRET,
    challengeTokenSecretPrevious: values.CHALLENGE_TOKEN_SECRET_PREVIOUS,
    notificationTargetEncryptionKey: Buffer.from(
      values.NOTIFICATION_TARGET_ENCRYPTION_KEY,
      "base64",
    ),
    notificationTargetEncryptionKeyVersion:
      values.NOTIFICATION_TARGET_ENCRYPTION_KEY_VERSION,
    notificationTargetEncryptionKeyPrevious:
      values.NOTIFICATION_TARGET_ENCRYPTION_KEY_PREVIOUS === undefined
        ? undefined
        : Buffer.from(
            values.NOTIFICATION_TARGET_ENCRYPTION_KEY_PREVIOUS,
            "base64",
          ),
    notificationTargetEncryptionKeyVersionPrevious:
      values.NOTIFICATION_TARGET_ENCRYPTION_KEY_VERSION_PREVIOUS,
    resultNotificationTemplateSetCode:
      values.RESULT_NOTIFICATION_TEMPLATE_SET_CODE,
    notificationSendUrl: values.NOTIFICATION_SEND_URL,
    rateLimitEnabled: values.RATE_LIMIT_ENABLED,
    allowedOrigins,
  };
}
