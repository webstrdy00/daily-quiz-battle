import {
  Analytics,
  Notification as TossNotification,
  Share,
  User,
} from "@apps-in-toss/web-framework";
import type { ReportReason } from "@daily-quiz-battle/contracts";

const isDevelopment =
  import.meta.env.DEV || import.meta.env.VITE_APP_ENV === "development";

export async function getAnonymousKey(): Promise<string> {
  try {
    const result = await User.getAnonymousKey();
    if (result.type === "HASH" && result.hash.length > 0) {
      return result.hash;
    }
  } catch {
    if (!isDevelopment) {
      throw new Error("앱인토스 사용자 정보를 가져오지 못했습니다.");
    }
  }

  const developmentKey = import.meta.env.VITE_DEV_ANONYMOUS_KEY;
  if (isDevelopment && developmentKey?.startsWith("dev-")) {
    return developmentKey;
  }

  throw new Error("사용자 식별 정보를 준비하지 못했습니다.");
}

export type ResultNotificationAgreement = "agreed" | "denied";

export class ResultNotificationAgreementUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultNotificationAgreementUnavailableError";
  }
}

export function requestResultNotificationAgreement(
  signal?: AbortSignal,
): Promise<ResultNotificationAgreement> {
  const templateCode =
    import.meta.env.VITE_RESULT_NOTIFICATION_TEMPLATE_CODE?.trim();
  if (!templateCode) {
    return Promise.reject(
      new ResultNotificationAgreementUnavailableError(
        "결과 알림 템플릿이 설정되지 않아 알림 동의를 요청할 수 없습니다.",
      ),
    );
  }

  let isSupported = false;
  try {
    isSupported =
      typeof TossNotification.requestAgreement.isSupported === "function" &&
      TossNotification.requestAgreement.isSupported();
  } catch {
    isSupported = false;
  }
  if (!isSupported) {
    return Promise.reject(
      new ResultNotificationAgreementUnavailableError(
        "현재 토스 앱에서는 결과 알림 동의를 지원하지 않습니다. 토스 앱을 업데이트해 주세요.",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let listenerCleanup: (() => void) | undefined;
    let cleanupRequested = false;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
      if (listenerCleanup) {
        const cleanupListener = listenerCleanup;
        listenerCleanup = undefined;
        try {
          cleanupListener();
        } catch {
          // Listener cleanup must not change the agreement outcome.
        }
      } else {
        cleanupRequested = true;
      }
    };
    const settle = (value: ResultNotificationAgreement) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error("결과 알림 동의 요청을 처리하지 못했습니다."),
      );
    };
    function handleAbort() {
      fail(
        new DOMException("결과 알림 동의 요청이 취소되었습니다.", "AbortError"),
      );
    }

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      listenerCleanup = TossNotification.requestAgreement({
        options: { templateCode },
        onEvent: ({ type }) => {
          if (type === "newAgreement" || type === "alreadyAgreed") {
            settle("agreed");
          } else if (type === "agreementRejected") {
            settle("denied");
          } else {
            fail(new Error("알림 동의 결과를 확인하지 못했습니다."));
          }
        },
        onError: fail,
      });
      if (cleanupRequested) {
        cleanup();
      }
    } catch (error) {
      fail(error);
    }
  });
}

export type ChallengeShareOutcome = "shared" | "cancelled";

export type AnalyticsEventName =
  | "complete_daily_quiz"
  | "click_share_challenge"
  | "share_challenge"
  | "share_challenge_cancelled"
  | "claim_challenge"
  | "complete_challenge"
  | "claim_conflict"
  | "answer_retry"
  | "question_report";

export interface SafeAnalyticsParams {
  role?: "creator" | "opponent";
  outcome?: "win" | "loss" | "draw";
  reason?: string;
  source?: "solo" | "challenge";
}

function isShareCancellation(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "AbortError" ||
    candidate.name === "CanceledError" ||
    candidate.code === "ABORT_ERR"
  );
}

export async function shareChallenge(
  token: string,
): Promise<ChallengeShareOutcome> {
  try {
    const link = await Share.createLink({
      path: `intoss://daily-quiz-battle/challenge/${token}`,
    });
    await Share.sendMessage({
      message: `오늘의 상식대결에 도전해 보세요!\n${link}`,
    });
    return "shared";
  } catch (error) {
    if (isShareCancellation(error)) {
      return "cancelled";
    }
    throw error;
  }
}

export function logAnalyticsEvent(
  name: "question_report",
  params: { reason: ReportReason },
): Promise<void>;
export function logAnalyticsEvent(
  name: Exclude<AnalyticsEventName, "question_report">,
  params?: SafeAnalyticsParams,
): Promise<void>;
export async function logAnalyticsEvent(
  name: AnalyticsEventName,
  params: SafeAnalyticsParams = {},
): Promise<void> {
  try {
    await Analytics.log({
      log_name: name,
      log_type: "event",
      params: { ...params },
    });
  } catch {
    // Analytics must never interrupt a quiz or challenge transition.
  }
}
