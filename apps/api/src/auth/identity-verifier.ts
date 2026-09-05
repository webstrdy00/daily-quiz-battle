import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AppError } from "../shared/errors.js";
import { mtlsRequest, readPem } from "../shared/mtls-request.js";

const VerificationResponseSchema = z.discriminatedUnion("resultType", [
  z.object({
    resultType: z.literal("SUCCESS"),
    success: z.boolean(),
  }),
  z.object({
    resultType: z.literal("FAIL"),
    error: z
      .object({
        code: z.union([z.string(), z.number()]),
      })
      .passthrough(),
  }),
]);

export interface IdentityVerifier {
  verify(anonymousKey: string): Promise<boolean>;
}

const APPS_IN_TOSS_DEVTOOLS_ANONYMOUS_KEY = "mock-anon-hash-xyz789";

class MockIdentityVerifier implements IdentityVerifier {
  async verify(anonymousKey: string): Promise<boolean> {
    return (
      anonymousKey.startsWith("dev-") ||
      anonymousKey === APPS_IN_TOSS_DEVTOOLS_ANONYMOUS_KEY
    );
  }
}

class MtlsIdentityVerifier implements IdentityVerifier {
  private readonly endpoint: URL;
  private readonly certificate: string;
  private readonly privateKey: string;
  private readonly certificateAuthority?: string;

  constructor(config: AppConfig) {
    if (!config.identityMtlsCert || !config.identityMtlsKey) {
      throw new Error("mTLS identity verifier is missing certificate material");
    }

    this.endpoint = new URL(config.identityVerifyUrl);
    this.certificate = readPem(config.identityMtlsCert);
    this.privateKey = readPem(config.identityMtlsKey);
    this.certificateAuthority = config.identityMtlsCa
      ? readPem(config.identityMtlsCa)
      : undefined;
  }

  async verify(anonymousKey: string): Promise<boolean> {
    let responseBody: string;

    try {
      const response = await mtlsRequest({
        endpoint: this.endpoint,
        method: "POST",
        certificate: this.certificate,
        privateKey: this.privateKey,
        certificateAuthority: this.certificateAuthority,
        headers: {
          accept: "application/json",
          "x-anon-key": anonymousKey,
        },
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(
          `Identity verification returned ${response.statusCode}`,
        );
      }
      responseBody = response.body;
    } catch (error) {
      throw new AppError({
        statusCode: 503,
        code: "IDENTITY_DEPENDENCY_UNAVAILABLE",
        message: "사용자 확인 서비스에 일시적으로 연결할 수 없습니다.",
        retryable: true,
        details: {
          reason: error instanceof Error ? error.name : "UnknownError",
        },
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(responseBody);
    } catch {
      throw new AppError({
        statusCode: 503,
        code: "IDENTITY_INVALID_RESPONSE",
        message: "사용자 확인 응답을 처리할 수 없습니다.",
        retryable: true,
      });
    }

    const parsed = VerificationResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new AppError({
        statusCode: 503,
        code: "IDENTITY_INVALID_RESPONSE",
        message: "사용자 확인 응답을 처리할 수 없습니다.",
        retryable: true,
      });
    }

    if (parsed.data.resultType === "SUCCESS") {
      return parsed.data.success;
    }

    const errorCode = String(parsed.data.error.code);
    if (errorCode === "4010") {
      return false;
    }

    throw new AppError({
      statusCode: 503,
      code: "IDENTITY_DEPENDENCY_UNAVAILABLE",
      message: "사용자 확인 서비스가 요청을 처리하지 못했습니다.",
      retryable: true,
    });
  }
}

export function createIdentityVerifier(config: AppConfig): IdentityVerifier {
  return config.identityVerificationMode === "mock"
    ? new MockIdentityVerifier()
    : new MtlsIdentityVerifier(config);
}
