import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

const LOCAL_DATABASE_URL =
  "postgres://daily_quiz:daily_quiz_local@localhost:5432/daily_quiz";
const LOCAL_PEPPER = "local-only-anon-key-pepper-change-before-production-2026";
const LOCAL_TOKEN_SECRET =
  "local-only-access-token-secret-change-before-production-2026";

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
  APP_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
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

  if (values.APP_ENV === "production") {
    if (values.ANON_KEY_PEPPER === LOCAL_PEPPER) {
      throw new Error(
        "Production ANON_KEY_PEPPER must not use the local default",
      );
    }

    if (values.ACCESS_TOKEN_SECRET === LOCAL_TOKEN_SECRET) {
      throw new Error(
        "Production ACCESS_TOKEN_SECRET must not use the local default",
      );
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
    allowedOrigins,
  };
}
