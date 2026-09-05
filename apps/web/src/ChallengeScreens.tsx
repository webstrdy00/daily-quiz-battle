import {
  type ChallengeLandingResponse,
  type ChallengeResultResponse,
} from "@daily-quiz-battle/contracts";
import { type Ref } from "react";

interface InlineMessage {
  title: string;
  message: string;
  requestId?: string;
}

export type ChallengeIssueKind =
  "self" | "expired" | "not-found" | "already-claimed";

export function ChallengeLandingScreen({
  landing,
  onClaim,
  onToday,
  busy,
  error,
  headingRef,
}: {
  landing: ChallengeLandingResponse;
  onClaim: () => void;
  onToday: () => void;
  busy: boolean;
  error: InlineMessage | null;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <main className="app-shell challenge-shell">
      <section className="hero-card" aria-labelledby="challenge-landing-title">
        <p className="eyebrow">FRIEND CHALLENGE</p>
        <h1 id="challenge-landing-title" ref={headingRef} tabIndex={-1}>
          {landing.creatorNickname} 님이 도전장을 보냈어요
        </h1>
        <p className="hero-copy">
          같은 날짜의 같은 5문제로 겨뤄요. 소요시간이 아니라 정답 수로만 승패를
          정합니다.
        </p>
        <div className="challenge-summary" aria-label="도전 정보">
          <span>퀴즈 날짜</span>
          <strong>{landing.quizDate}</strong>
        </div>
        {error ? (
          <div className="inline-error" role="alert">
            <strong>{error.title}</strong>
            <span>{error.message}</span>
            {error.requestId ? (
              <small>문의 코드: {error.requestId}</small>
            ) : null}
          </div>
        ) : null}
        <button className="primary-button" onClick={onClaim} disabled={busy}>
          {busy ? "도전을 수락하는 중…" : "도전 수락하고 풀기"}
        </button>
        <button className="secondary-button" onClick={onToday} disabled={busy}>
          개인 오늘 퀴즈로 이동
        </button>
        <p className="save-status" aria-live="polite">
          {busy
            ? "참여 권한과 오늘의 문제를 준비하고 있어요."
            : "수락하기 전에는 도전 참여가 확정되지 않아요."}
        </p>
      </section>
    </main>
  );
}

export function ChallengeWaitingScreen({
  result,
  paused,
  refreshing,
  onRefresh,
  onShare,
  onToday,
  error,
  message,
  headingRef,
}: {
  result: ChallengeResultResponse | null;
  paused: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onShare: (() => void) | null;
  onToday: () => void;
  error: InlineMessage | null;
  message: string | null;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  if (result === null) {
    return (
      <main className="app-shell challenge-shell">
        <section
          className="card challenge-status-card"
          aria-labelledby="challenge-waiting-title"
        >
          <span className="status-icon challenge-clock" aria-hidden="true">
            ···
          </span>
          <p className="eyebrow">CHALLENGE STATUS</p>
          <h1 id="challenge-waiting-title" ref={headingRef} tabIndex={-1}>
            대결 상태를 불러오지 못했어요
          </h1>
          <p className="challenge-live-status" aria-live="polite">
            {refreshing
              ? "최신 대결 상태를 다시 확인하고 있어요."
              : (message ?? "잠시 후 직접 다시 시도해 주세요.")}
          </p>
          {error ? (
            <div className="inline-error" role="alert">
              <strong>{error.title}</strong>
              <span>{error.message}</span>
              {error.requestId ? (
                <small>문의 코드: {error.requestId}</small>
              ) : null}
            </div>
          ) : null}
          <button
            className="primary-button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "다시 확인하는 중…" : "대결 상태 다시 확인"}
          </button>
          <button
            className="text-button"
            onClick={onToday}
            disabled={refreshing}
          >
            개인 오늘 퀴즈로 이동
          </button>
        </section>
      </main>
    );
  }

  if (result.status === "completed" || result.status === "redacted") {
    return null;
  }

  const isCreator = result.viewerRole === "creator";
  const title =
    result.status === "open"
      ? "친구의 참여를 기다리고 있어요"
      : isCreator
        ? "친구가 퀴즈를 풀고 있어요"
        : "대결 결과를 계산하고 있어요";
  const status = paused
    ? "화면이 숨겨져 자동 확인을 잠시 멈췄어요."
    : refreshing
      ? "최신 대결 상태를 확인하고 있어요."
      : message !== null
        ? message
        : result.status === "open"
          ? "아직 도전을 수락한 친구가 없어요."
          : "상대가 완료하면 결과가 자동으로 표시돼요.";

  return (
    <main className="app-shell challenge-shell">
      <section
        className="card challenge-status-card"
        aria-labelledby="challenge-waiting-title"
      >
        <span className="status-icon challenge-clock" aria-hidden="true">
          ···
        </span>
        <p className="eyebrow">CHALLENGE STATUS</p>
        <h1 id="challenge-waiting-title" ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        <div className="versus-row" aria-label="현재 대결 점수">
          <div>
            <strong>{result.me.score ?? "?"}</strong>
            <span>{result.me.nickname}</span>
          </div>
          <b>VS</b>
          <div>
            <strong>?</strong>
            <span>{result.opponent.nickname ?? "도전자 대기 중"}</span>
          </div>
        </div>
        <p className="challenge-live-status" aria-live="polite">
          {status}
        </p>
        {error ? (
          <div className="inline-error" role="alert">
            <strong>{error.title}</strong>
            <span>{error.message}</span>
            {error.requestId ? (
              <small>문의 코드: {error.requestId}</small>
            ) : null}
          </div>
        ) : null}
        <button
          className="primary-button"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "새로고침 중…" : "지금 새로고침"}
        </button>
        {onShare ? (
          <button
            className="secondary-button"
            onClick={onShare}
            disabled={refreshing}
          >
            도전장 다시 공유
          </button>
        ) : null}
        <button className="text-button" onClick={onToday} disabled={refreshing}>
          개인 오늘 퀴즈로 이동
        </button>
      </section>
    </main>
  );
}

export function ChallengeResultScreen({
  result,
  onToday,
  headingRef,
}: {
  result: ChallengeResultResponse;
  onToday: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  if (result.status !== "completed" && result.status !== "redacted") {
    return null;
  }

  if (result.status === "redacted") {
    return (
      <main className="app-shell challenge-shell">
        <section
          className="card challenge-status-card"
          aria-labelledby="challenge-result-title"
        >
          <span className="status-icon status-icon-error" aria-hidden="true">
            –
          </span>
          <p className="eyebrow">CHALLENGE RESULT</p>
          <h1 id="challenge-result-title" ref={headingRef} tabIndex={-1}>
            대결 결과가 비공개 처리됐어요
          </h1>
          <p aria-live="polite">
            참여자 정보 보호를 위해 상대 정보와 승패를 더 이상 표시할 수 없어요.
            내 점수는 {result.me.score ?? "확인되지 않음"}점이에요.
          </p>
          <button className="primary-button" onClick={onToday}>
            개인 오늘 퀴즈로 이동
          </button>
        </section>
      </main>
    );
  }

  const title =
    result.outcome === "win"
      ? "승리했어요!"
      : result.outcome === "loss"
        ? "아쉽게 패배했어요"
        : "무승부예요!";

  return (
    <main className="app-shell challenge-shell">
      <section
        className="card challenge-status-card"
        aria-labelledby="challenge-result-title"
      >
        <span
          className={`status-icon ${result.outcome === "win" ? "status-icon-success" : "challenge-result-icon"}`}
          aria-hidden="true"
        >
          {result.outcome === "win"
            ? "✓"
            : result.outcome === "loss"
              ? "!"
              : "="}
        </span>
        <p className="eyebrow">CHALLENGE RESULT</p>
        <h1 id="challenge-result-title" ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        <div className="versus-row versus-complete" aria-label="최종 대결 점수">
          <div>
            <strong>{result.me.score}</strong>
            <span>{result.me.nickname}</span>
          </div>
          <b>VS</b>
          <div>
            <strong>{result.opponent.score}</strong>
            <span>{result.opponent.nickname}</span>
          </div>
        </div>
        <p aria-live="polite">5문제의 정답 수로 계산한 최종 결과예요.</p>
        <button className="primary-button" onClick={onToday}>
          개인 오늘 퀴즈로 이동
        </button>
      </section>
    </main>
  );
}

export function ChallengeIssueScreen({
  kind,
  onToday,
  headingRef,
}: {
  kind: ChallengeIssueKind;
  onToday: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const content = {
    self: {
      title: "내가 만든 도전에는 참여할 수 없어요",
      message: "내 도전 현황에서 친구의 참여와 결과를 확인해 주세요.",
    },
    expired: {
      title: "도전 시간이 종료됐어요",
      message: "이 도전의 완료 가능 시간이 지나 더 이상 참여할 수 없어요.",
    },
    "not-found": {
      title: "도전을 찾을 수 없어요",
      message: "링크가 올바르지 않거나 만료되어 사용할 수 없어요.",
    },
    "already-claimed": {
      title: "이미 다른 친구가 참여했어요",
      message: "한 도전에는 한 명만 참여할 수 있어요.",
    },
  }[kind];

  return (
    <main className="app-shell challenge-shell">
      <section className="card error-card" role="alert">
        <span className="status-icon status-icon-error" aria-hidden="true">
          !
        </span>
        <h1 ref={headingRef} tabIndex={-1}>
          {content.title}
        </h1>
        <p>{content.message}</p>
        <button className="primary-button" onClick={onToday}>
          개인 오늘 퀴즈로 이동
        </button>
      </section>
    </main>
  );
}
