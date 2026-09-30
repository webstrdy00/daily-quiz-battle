import { z } from "zod";
import type { ChallengeTokenService } from "../challenge/token.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../shared/errors.js";
import { mtlsRequest, readPem } from "../shared/mtls-request.js";
import type {
  EncryptedNotificationTarget,
  NotificationTargetCrypto,
} from "./target-crypto.js";

const MAX_RESPONSE_BYTES = 65_536;

const MessageCountSchema = z.number().int().min(0).max(2_147_483_647);
const SentContentSchema = z.object({
  contentId: z.string(),
  reachedFailReason: z.string().optional(),
});
const ChannelResultsSchema = z.object({
  sentAlimtalk: z.array(SentContentSchema),
  sentFriendtalk: z.array(SentContentSchema),
  sentInbox: z.array(SentContentSchema),
  sentPush: z.array(SentContentSchema),
  sentSms: z.array(SentContentSchema),
});
const CHANNELS = [
  "sentAlimtalk",
  "sentFriendtalk",
  "sentInbox",
  "sentPush",
  "sentSms",
] as const;

const NotificationSuccessSchema = z.object({
  resultType: z.literal("SUCCESS"),
  success: z.object({
    detail: ChannelResultsSchema,
    fail: ChannelResultsSchema,
    msgCount: MessageCountSchema,
    sentAlimtalkCount: MessageCountSchema,
    sentFriendtalkCount: MessageCountSchema,
    sentInboxCount: MessageCountSchema,
    sentPushCount: MessageCountSchema,
    sentSmsCount: MessageCountSchema,
  }),
});

const NotificationFailureSchema = z.object({
  resultType: z.string().refine((value) => value !== "SUCCESS"),
  error: z
    .object({
      errorCode: z.string(),
    })
    .passthrough(),
});

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

export function classifyNotificationRequestFailure(error: unknown): AppError {
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

export function interpretNotificationResponse(response: {
  statusCode: number;
  body: string;
}): void {
  if (
    response.statusCode === 429 ||
    (response.statusCode >= 500 && response.statusCode < 600)
  ) {
    throw deliveryUnavailable();
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw deliveryRejected();
  }

  if (Buffer.byteLength(response.body) > MAX_RESPONSE_BYTES) {
    throw deliveryRejected();
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.body);
  } catch {
    throw deliveryRejected();
  }

  const success = NotificationSuccessSchema.safeParse(parsedJson);
  if (success.success) {
    const outcome = success.data.success;
    // A SUCCESS envelope alone is not evidence that any message was sent.
    if (
      outcome.msgCount === 0 ||
      !CHANNELS.some(
        (channel) =>
          outcome[`${channel}Count`] > 0 &&
          outcome.detail[channel].some((item) => !item.reachedFailReason),
      )
    ) {
      throw deliveryRejected();
    }
    return;
  }

  const failure = NotificationFailureSchema.safeParse(parsedJson);
  if (!failure.success) {
    throw deliveryRejected();
  }

  if (
    response.statusCode === 200 &&
    failure.data.resultType === "FAIL" &&
    failure.data.error.errorCode === "4095"
  ) {
    throw deliveryUnavailable();
  }

  switch (failure.data.error.errorCode) {
    case "5004":
    case "4034":
      throw invalidConfiguration();
    case "4010":
      throw invalidTarget();
    default:
      throw deliveryRejected();
  }
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
    const challengeLink = `intoss://daily-quiz-battle-anlee/challenge/${challengeToken}`;
    const body = JSON.stringify({
      templateSetCode: this.templateSetCode,
      context: { challengeLink },
    });

    try {
      const response = await mtlsRequest({
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

      interpretNotificationResponse(response);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw classifyNotificationRequestFailure(error);
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
