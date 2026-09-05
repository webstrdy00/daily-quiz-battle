import type { ChallengeTokenService } from "../challenge/token.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../shared/errors.js";
import { mtlsRequest, readPem } from "../shared/mtls-request.js";
import type {
  EncryptedNotificationTarget,
  NotificationTargetCrypto,
} from "./target-crypto.js";

export interface SendNotificationInput {
  userId: string;
  target: EncryptedNotificationTarget;
  challengeId: string;
  challengeTokenHash: string;
}

export interface NotificationSender {
  send(input: SendNotificationInput): Promise<void>;
}

function deliveryUnavailable(): AppError {
  return new AppError({
    statusCode: 503,
    code: "NOTIFICATION_DELIVERY_UNAVAILABLE",
    message: "알림을 일시적으로 발송할 수 없습니다.",
    retryable: true,
  });
}

function deliveryRejected(): AppError {
  return new AppError({
    statusCode: 502,
    code: "NOTIFICATION_DELIVERY_REJECTED",
    message: "알림 발송 요청이 거부되었습니다.",
  });
}

function invalidConfiguration(): AppError {
  return new AppError({
    statusCode: 500,
    code: "NOTIFICATION_CONFIGURATION_INVALID",
    message: "알림 발송 설정이 올바르지 않습니다.",
  });
}

function invalidTarget(): AppError {
  return new AppError({
    statusCode: 500,
    code: "NOTIFICATION_TARGET_INVALID",
    message: "알림 수신 대상을 확인할 수 없습니다.",
  });
}

function invalidChallengeToken(): AppError {
  return new AppError({
    statusCode: 500,
    code: "NOTIFICATION_CHALLENGE_TOKEN_INVALID",
    message: "알림 링크를 생성할 수 없습니다.",
  });
}

function classifyRequestFailure(error: unknown): AppError {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code?.startsWith("ERR_OSSL_")) {
      return invalidConfiguration();
    }
    if (
      code === "ERR_HTTP_INVALID_HEADER_VALUE" ||
      code === "ERR_INVALID_CHAR"
    ) {
      return invalidTarget();
    }
    if (
      error.message === "mTLS endpoint must use HTTPS" ||
      error.message === "mTLS response is too large"
    ) {
      return deliveryRejected();
    }
  }

  return deliveryUnavailable();
}

class MtlsNotificationSender implements NotificationSender {
  constructor(
    private readonly endpoint: URL,
    private readonly templateSetCode: string,
    private readonly certificate: string,
    private readonly privateKey: string,
    private readonly certificateAuthority: string | undefined,
    private readonly targetCrypto: NotificationTargetCrypto,
    private readonly challengeTokenService: ChallengeTokenService,
  ) {}

  async send(input: SendNotificationInput): Promise<void> {
    let anonymousKey: string;
    try {
      anonymousKey = this.targetCrypto.decrypt(input.userId, input.target);
    } catch {
      throw invalidTarget();
    }

    let challengeToken: string | null;
    try {
      challengeToken = this.challengeTokenService.deriveMatching(
        input.challengeId,
        input.challengeTokenHash,
      );
    } catch {
      throw invalidChallengeToken();
    }
    if (challengeToken === null) {
      throw invalidChallengeToken();
    }
    const challengeLink = `intoss://daily-quiz-battle/challenge/${challengeToken}`;
    const body = JSON.stringify({
      templateSetCode: this.templateSetCode,
      context: { challengeLink },
    });

    try {
      const { statusCode } = await mtlsRequest({
        endpoint: this.endpoint,
        method: "POST",
        certificate: this.certificate,
        privateKey: this.privateKey,
        certificateAuthority: this.certificateAuthority,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-anon-key": anonymousKey,
        },
        body,
      });

      if (statusCode >= 200 && statusCode < 300) {
        return;
      }
      if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
        throw deliveryUnavailable();
      }
      throw deliveryRejected();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw classifyRequestFailure(error);
    }
  }
}

export function createNotificationSender(
  config: AppConfig,
  targetCrypto: NotificationTargetCrypto,
  challengeTokenService: ChallengeTokenService,
): NotificationSender {
  try {
    if (
      !config.resultNotificationTemplateSetCode ||
      !config.identityMtlsCert ||
      !config.identityMtlsKey
    ) {
      throw invalidConfiguration();
    }

    const endpoint = new URL(config.notificationSendUrl);
    if (endpoint.protocol !== "https:") {
      throw invalidConfiguration();
    }

    return new MtlsNotificationSender(
      endpoint,
      config.resultNotificationTemplateSetCode,
      readPem(config.identityMtlsCert),
      readPem(config.identityMtlsKey),
      config.identityMtlsCa ? readPem(config.identityMtlsCa) : undefined,
      targetCrypto,
      challengeTokenService,
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidConfiguration();
  }
}
