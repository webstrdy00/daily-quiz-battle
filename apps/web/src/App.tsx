import {
  type ChallengeLandingResponse,
  type ChallengeResultResponse,
  type CompleteAttemptResponse,
  type DailyStartResponse,
  type PublicQuestion,
} from "@daily-quiz-battle/contracts";
import {
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiClientError,
  claimChallenge,
  completeAttempt,
  createChallenge,
  createIdempotencyKey,
  deleteAccount,
  getChallengeLanding,
  getChallengeResult,
  getResultNotificationPreference,
  startDailyQuiz,
  submitAnswer,
  updateResultNotificationPreference,
} from "./lib/api";
import {
  ChallengeIssueScreen,
  ChallengeLandingScreen,
  ChallengeResultScreen,
  ChallengeWaitingScreen,
  type ChallengeIssueKind,
} from "./ChallengeScreens";
import { AccountSettings } from "./AccountSettings";
import { QuestionReport } from "./QuestionReport";
import {
  logAnalyticsEvent,
  requestResultNotificationAgreement,
  shareChallenge,
} from "./lib/platform";
import "./App.css";

type Screen =
  | "loading"
  | "home"
  | "quiz"
  | "result"
  | "settings"
  | "deleted"
  | "error"
  | "challenge-landing"
  | "challenge-waiting"
  | "challenge-result"
  | "challenge-issue";

interface DisplayError {
  title: string;
  message: string;
  requestId?: string;
}

interface PendingAnswer {
  key: string;
  sequence: number;
  revisionId: string;
  selectedIndex: number;
}

const challengePathPattern = /^\/challenge\/([A-Za-z0-9_-]{43})\/?$/;
let capturedInitialChallengeToken: string | null | undefined;

function takeInitialChallengeToken(): string | null {
  if (capturedInitialChallengeToken !== undefined) {
    return capturedInitialChallengeToken;
  }

  const match = challengePathPattern.exec(window.location.pathname);
  capturedInitialChallengeToken = match?.[1] ?? null;
  if (capturedInitialChallengeToken !== null) {
    window.history.replaceState(null, "", "/challenge");
  }
  return capturedInitialChallengeToken;
}

function challengeIssueFromError(error: unknown): ChallengeIssueKind | null {
  if (!(error instanceof ApiClientError)) {
    return null;
  }
  if (error.code === "SELF_CLAIM_FORBIDDEN") {
    return "self";
  }
  if (error.code === "ALREADY_CLAIMED") {
    return "already-claimed";
  }
  if (error.code === "CHALLENGE_NOT_FOUND") {
    return "not-found";
  }
  if (error.code === "ATTEMPT_ABANDONED") {
    return "expired";
  }
  return null;
}

function toDisplayError(error: unknown): DisplayError {
  if (error instanceof ApiClientError) {
    return {
      title: error.retryable ? "잠시 연결이 불안정해요" : "진행할 수 없어요",
      message: error.message,
      requestId: error.requestId,
    };
  }
  if (error instanceof Error) {
    return { title: "문제가 발생했어요", message: error.message };
  }
  return {
    title: "문제가 발생했어요",
    message: "잠시 후 다시 시도해 주세요.",
  };
}

function LoadingScreen({
  headingRef,
  challenge,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  challenge: boolean;
}) {
  return (
    <main className="app-shell" aria-busy="true">
      <section className="card loading-card" aria-labelledby="loading-title">
        <div className="brand-mark" aria-hidden="true">
          Q
        </div>
        <h1 id="loading-title" ref={headingRef} tabIndex={-1}>
          {challenge
            ? "도전장을 확인하고 있어요"
            : "오늘의 퀴즈를 준비하고 있어요"}
        </h1>
        <div className="loading-bar" aria-hidden="true">
          <span />
        </div>
        <p aria-live="polite">
          {challenge
            ? "참여 가능한 도전인지 안전하게 확인하는 중이에요."
            : "서버에서 같은 5문제를 안전하게 불러오는 중이에요."}
        </p>
      </section>
    </main>
  );
}

function ErrorPanel({
  error,
  onRetry,
  busy,
  headingRef,
}: {
  error: DisplayError;
  onRetry: () => void;
  busy: boolean;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <main className="app-shell">
      <section className="card error-card" role="alert">
        <span className="status-icon status-icon-error" aria-hidden="true">
          !
        </span>
        <h1 ref={headingRef} tabIndex={-1}>
          {error.title}
        </h1>
        <p>{error.message}</p>
        {error.requestId ? (
          <p className="request-id">문의 코드: {error.requestId}</p>
        ) : null}
        <button className="primary-button" onClick={onRetry} disabled={busy}>
          {busy ? "다시 연결하는 중…" : "다시 시도"}
        </button>
      </section>
    </main>
  );
}

function HomeScreen({
  daily,
  onStart,
  onSettings,
  headingRef,
}: {
  daily: DailyStartResponse;
  onStart: () => void;
  onSettings: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const answeredCount = daily.attempt.answeredCount;
  const isResume = answeredCount > 0;

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="brand-lockup">
          <span className="brand-mark brand-mark-small" aria-hidden="true">
            Q
          </span>
          <span>오늘의 상식대결</span>
        </div>
        <span className="date-chip">{daily.attempt.quizDate}</span>
      </header>

      <section className="hero-card" aria-labelledby="home-title">
        <p className="eyebrow">DAILY QUIZ · 5 QUESTIONS</p>
        <h1 id="home-title" ref={headingRef} tabIndex={-1}>
          오늘 5문제, 얼마나 맞힐까요?
        </h1>
        <p className="hero-copy">
          모두에게 같은 문제가 제공돼요. 1~2분이면 오늘의 상식 점수를 확인할 수
          있어요.
        </p>

        {isResume ? (
          <div className="resume-box">
            <strong>{answeredCount}문제까지 저장됐어요</strong>
            <span>중단한 곳부터 안전하게 이어집니다.</span>
          </div>
        ) : (
          <div className="quiz-preview" aria-label="퀴즈 구성">
            <div>
              <strong>5</strong>
              <span>오늘의 문제</span>
            </div>
            <div>
              <strong>4지</strong>
              <span>선다형</span>
            </div>
            <div>
              <strong>1회</strong>
              <span>공정한 도전</span>
            </div>
          </div>
        )}

        <button className="primary-button hero-button" onClick={onStart}>
          {isResume ? "이어서 풀기" : "오늘 퀴즈 시작"}
        </button>
        <button className="text-button" onClick={onSettings}>
          계정 설정
        </button>
        <p className="trust-copy">
          제출한 답은 바꿀 수 없으며 점수는 서버가 계산해요.
        </p>
      </section>
    </main>
  );
}

function QuizScreen({
  daily,
  selectedIndex,
  onSelect,
  onSubmit,
  onComplete,
  busy,
  actionError,
  headingRef,
}: {
  daily: DailyStartResponse;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onSubmit: () => void;
  onComplete: () => void;
  busy: boolean;
  actionError: DisplayError | null;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const answeredCount = daily.attempt.answeredCount;
  const question: PublicQuestion | undefined = daily.questions[answeredCount];

  if (question === undefined) {
    return (
      <main className="app-shell">
        <section className="card finishing-card">
          <span className="status-icon status-icon-success" aria-hidden="true">
            ✓
          </span>
          <h1 ref={headingRef} tabIndex={-1}>
            5문제를 모두 저장했어요
          </h1>
          <p>서버에서 정답을 확인하고 점수를 계산할게요.</p>
          {actionError ? (
            <div className="inline-error" role="alert">
              <strong>{actionError.title}</strong>
              <span>{actionError.message}</span>
            </div>
          ) : null}
          <button
            className="primary-button"
            onClick={onComplete}
            disabled={busy}
          >
            {busy ? "점수 계산 중…" : "결과 확인"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell quiz-shell">
      <header className="quiz-header">
        <div className="progress-label">
          <span>
            문제 <strong>{question.sequence}</strong> / 5
          </span>
          <span>{Math.round((answeredCount / 5) * 100)}%</span>
        </div>
        <progress value={answeredCount} max={5} aria-label="퀴즈 진행률" />
      </header>

      <section className="question-card" aria-labelledby="question-title">
        <p className="category-label">오늘의 상식</p>
        <h1 id="question-title" ref={headingRef} tabIndex={-1}>
          {question.prompt}
        </h1>

        <fieldset disabled={busy}>
          <legend className="sr-only">정답 선택</legend>
          <div className="choice-list">
            {question.choices.map((choice, index) => {
              const selected = selectedIndex === index;
              return (
                <label
                  className={`choice ${selected ? "choice-selected" : ""}`}
                  key={choice}
                >
                  <input
                    type="radio"
                    name={`question-${question.sequence}`}
                    value={index}
                    checked={selected}
                    onChange={() => onSelect(index)}
                  />
                  <span className="choice-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="choice-text">{choice}</span>
                  <span className="choice-check" aria-hidden="true">
                    {selected ? "✓" : ""}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {actionError ? (
          <div className="inline-error" role="alert">
            <strong>{actionError.title}</strong>
            <span>{actionError.message}</span>
            {actionError.requestId ? (
              <small>문의 코드: {actionError.requestId}</small>
            ) : null}
          </div>
        ) : null}

        <button
          className="primary-button submit-button"
          onClick={onSubmit}
          disabled={selectedIndex === null || busy}
        >
          {busy ? "답을 저장하는 중…" : "이 답으로 제출"}
        </button>
        <p className="save-status" aria-live="polite">
          {busy
            ? "서버에 안전하게 저장하고 있어요."
            : "선택 후 제출하면 답을 바꿀 수 없어요."}
        </p>
      </section>
    </main>
  );
}

function ResultScreen({
  daily,
  result,
  onRestart,
  onSettings,
  onShare,
  onChallengeStatus,
  challengeCreated,
  busy,
  actionError,
  shareMessage,
  reportPending,
  onReportPendingChange,
  headingRef,
}: {
  daily: DailyStartResponse;
  result: CompleteAttemptResponse;
  onRestart: () => void;
  onSettings: () => void;
  onShare: () => void;
  onChallengeStatus: () => void;
  challengeCreated: boolean;
  busy: boolean;
  actionError: DisplayError | null;
  shareMessage: string | null;
  reportPending: boolean;
  onReportPendingChange: (pending: boolean) => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [openReportSequence, setOpenReportSequence] = useState<number | null>(
    null,
  );
  const resultLabel =
    result.score === 5
      ? "완벽해요! 오늘의 상식 챔피언"
      : result.score >= 3
        ? "꽤 아는 편이에요"
        : "내일은 더 잘할 수 있어요";

  return (
    <main className="app-shell result-shell">
      <section className="result-hero" aria-labelledby="result-title">
        <p className="eyebrow">TODAY&apos;S RESULT</p>
        <h1 id="result-title" ref={headingRef} tabIndex={-1}>
          오늘 퀴즈 완료!
        </h1>
        <div
          className="score-circle"
          aria-label={`5문제 중 ${result.score}문제 정답`}
        >
          <strong>{result.score}</strong>
          <span>/ 5</span>
        </div>
        <p className="result-label">{resultLabel}</p>
        <p>소요시간은 승패에 사용하지 않아요. 정답 수로만 공정하게 겨룹니다.</p>
      </section>

      <section className="review-section" aria-labelledby="review-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ANSWER REVIEW</p>
            <h2 id="review-title">정답 확인</h2>
          </div>
          <span>{result.score} / 5 정답</span>
        </div>

        <ol className="review-list">
          {result.review.map((item) => {
            const question = daily.questions[item.sequence - 1];
            const selectedChoice =
              question?.choices[item.selectedIndex] ?? "선택 정보 없음";
            const correctChoice =
              question?.choices[item.correctIndex] ?? "정답 정보 없음";

            return (
              <li
                className={`review-card ${item.correct ? "review-correct" : "review-wrong"}`}
                key={item.sequence}
              >
                <div className="review-status">
                  <span aria-hidden="true">{item.correct ? "✓" : "×"}</span>
                  <strong>{item.correct ? "정답" : "오답"}</strong>
                  <small>문제 {item.sequence}</small>
                </div>
                <h3>{item.prompt}</h3>
                <dl>
                  <div>
                    <dt>내 답</dt>
                    <dd>{selectedChoice}</dd>
                  </div>
                  {!item.correct ? (
                    <div>
                      <dt>정답</dt>
                      <dd>{correctChoice}</dd>
                    </div>
                  ) : null}
                </dl>
                <p className="explanation">{item.explanation}</p>
                {question ? (
                  <QuestionReport
                    sequence={item.sequence}
                    questionRevisionId={question.revisionId}
                    open={openReportSequence === item.sequence}
                    onOpen={() => setOpenReportSequence(item.sequence)}
                    onClose={() => setOpenReportSequence(null)}
                    onPendingChange={onReportPendingChange}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="next-step-card">
        <strong>친구와 오늘 점수로 대결해 보세요.</strong>
        <span>도전장을 받은 친구는 같은 날짜의 같은 5문제를 풀게 돼요.</span>
        {actionError ? (
          <div className="inline-error" role="alert">
            <strong>{actionError.title}</strong>
            <span>{actionError.message}</span>
          </div>
        ) : null}
        {shareMessage ? (
          <p className="challenge-live-status" aria-live="polite">
            {shareMessage}
          </p>
        ) : null}
        <button
          className="primary-button"
          onClick={onShare}
          disabled={busy || reportPending}
        >
          {busy
            ? "도전장을 준비하는 중…"
            : challengeCreated
              ? "도전장 다시 공유"
              : "친구에게 도전장 보내기"}
        </button>
        {challengeCreated ? (
          <button
            className="secondary-button"
            onClick={onChallengeStatus}
            disabled={busy || reportPending}
          >
            대결 현황 보기
          </button>
        ) : null}
        <button
          className="text-button"
          onClick={onRestart}
          disabled={busy || reportPending}
        >
          저장된 결과 다시 불러오기
        </button>
        <button
          className="text-button"
          onClick={onSettings}
          disabled={busy || reportPending}
        >
          계정 설정
        </button>
      </section>
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [daily, setDaily] = useState<DailyStartResponse | null>(null);
  const [result, setResult] = useState<CompleteAttemptResponse | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(
    takeInitialChallengeToken,
  );
  const [challengeLanding, setChallengeLanding] =
    useState<ChallengeLandingResponse | null>(null);
  const [challengeResult, setChallengeResult] =
    useState<ChallengeResultResponse | null>(null);
  const [challengeRole, setChallengeRole] = useState<
    "creator" | "opponent" | null
  >(null);
  const [challengeIssue, setChallengeIssue] =
    useState<ChallengeIssueKind>("not-found");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingChallenge, setRefreshingChallenge] = useState(false);
  const [pollingPaused, setPollingPaused] = useState(document.hidden);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<DisplayError | null>(null);
  const [actionError, setActionError] = useState<DisplayError | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState<
    boolean | null
  >(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [reportPending, setReportPending] = useState(false);
  const [notificationError, setNotificationError] =
    useState<DisplayError | null>(null);
  const [settingsReturnScreen, setSettingsReturnScreen] = useState<
    "home" | "result"
  >("home");
  const accountDeleted = useRef(false);
  const initialChallengeToken = useRef(challengeToken);
  const initializationGeneration = useRef(0);
  const initializationAbort = useRef<AbortController | null>(null);
  const pendingAnswer = useRef<PendingAnswer | null>(null);
  const pendingCompleteKey = useRef<string | null>(null);
  const pendingChallengeCreateKey = useRef<string | null>(null);
  const pendingClaimKey = useRef<string | null>(null);
  const notificationAgreementAbort = useRef<AbortController | null>(null);
  const loggedDailyCompletions = useRef(new Set<string>());
  const loggedChallengeCompletion = useRef(false);
  const mainHeading = useRef<HTMLHeadingElement>(null);
  const lastFocusedHeading = useRef<string | null>(null);

  const showChallengeResult = useCallback(
    (loadedResult: ChallengeResultResponse) => {
      setChallengeResult(loadedResult);
      setChallengeRole(loadedResult.viewerRole);

      if (loadedResult.status === "completed") {
        if (!loggedChallengeCompletion.current) {
          loggedChallengeCompletion.current = true;
          void logAnalyticsEvent("complete_challenge", {
            role: loadedResult.viewerRole,
            outcome: loadedResult.outcome,
          });
        }
        setScreen("challenge-result");
        return;
      }
      if (loadedResult.status === "redacted") {
        setScreen("challenge-result");
        return;
      }
      setPollingPaused(document.hidden);
      setScreen("challenge-waiting");
    },
    [],
  );

  const initializeDaily = useCallback(async () => {
    initializationAbort.current?.abort();
    const controller = new AbortController();
    initializationAbort.current = controller;
    const generation = ++initializationGeneration.current;
    const isCurrent = () =>
      !controller.signal.aborted &&
      initializationGeneration.current === generation &&
      !accountDeleted.current;

    setBusy(true);
    setScreen("loading");
    setFatalError(null);
    setActionError(null);

    try {
      const loadedDaily = await startDailyQuiz(controller.signal);
      if (!isCurrent()) {
        return;
      }
      setDaily(loadedDaily);
      setSelectedIndex(null);

      if (loadedDaily.attempt.status === "abandoned") {
        throw new Error(
          "오늘 퀴즈의 완료 가능 시간이 지났어요. 새 퀴즈를 기다려 주세요.",
        );
      }

      if (loadedDaily.attempt.status === "completed") {
        const loadedResult = await completeAttempt(
          loadedDaily.attempt.id,
          createIdempotencyKey("complete-resume"),
          controller.signal,
        );
        if (!isCurrent()) {
          return;
        }
        setResult(loadedResult);
        setScreen("result");
      } else {
        setResult(null);
        setScreen("home");
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      setFatalError(toDisplayError(error));
      setScreen("error");
    } finally {
      if (isCurrent()) {
        initializationAbort.current = null;
        setBusy(false);
      }
    }
  }, []);

  const initializeChallenge = useCallback(
    async (token: string) => {
      initializationAbort.current?.abort();
      const controller = new AbortController();
      initializationAbort.current = controller;
      const generation = ++initializationGeneration.current;
      const isCurrent = () =>
        !controller.signal.aborted &&
        initializationGeneration.current === generation &&
        !accountDeleted.current;

      setBusy(true);
      setScreen("loading");
      setFatalError(null);
      setActionError(null);

      try {
        const landing = await getChallengeLanding(token, controller.signal);
        if (!isCurrent()) {
          return;
        }
        setChallengeLanding(landing);

        if (landing.status === "expired") {
          setChallengeIssue("expired");
          setScreen("challenge-issue");
          return;
        }
        if (landing.viewerRole === "none") {
          if (landing.status === "open") {
            setScreen("challenge-landing");
          } else {
            setChallengeIssue("already-claimed");
            setScreen("challenge-issue");
          }
          return;
        }

        setChallengeRole(landing.viewerRole);
        if (landing.viewerRole === "opponent" && landing.status === "claimed") {
          const resumed = await claimChallenge(
            token,
            createIdempotencyKey("claim-resume"),
            controller.signal,
          );
          if (!isCurrent()) {
            return;
          }
          setDaily(resumed.daily);
          setResult(null);
          setSelectedIndex(null);
          if (resumed.daily.attempt.status !== "completed") {
            setScreen("quiz");
            return;
          }
        }
        const loadedResult = await getChallengeResult(token, controller.signal);
        if (!isCurrent()) {
          return;
        }
        showChallengeResult(loadedResult);
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        const issue = challengeIssueFromError(error);
        if (issue !== null) {
          setChallengeIssue(issue);
          setScreen("challenge-issue");
        } else {
          setFatalError(toDisplayError(error));
          setScreen("error");
        }
      } finally {
        if (isCurrent()) {
          initializationAbort.current = null;
          setBusy(false);
        }
      }
    },
    [showChallengeResult],
  );

  useEffect(() => {
    const token = initialChallengeToken.current;
    const timer = window.setTimeout(() => {
      if (token === null) {
        void initializeDaily();
      } else {
        void initializeChallenge(token);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      initializationAbort.current?.abort();
      initializationAbort.current = null;
      initializationGeneration.current += 1;
    };
  }, [initializeChallenge, initializeDaily]);

  const currentQuestion = useMemo(
    () => daily?.questions[daily.attempt.answeredCount],
    [daily],
  );
  const headingFocusKey =
    screen === "quiz"
      ? `quiz:${daily?.attempt.id ?? "unknown"}:${currentQuestion?.revisionId ?? "complete"}`
      : screen === "challenge-waiting"
        ? "challenge-waiting"
        : screen;

  useEffect(() => {
    if (
      lastFocusedHeading.current === headingFocusKey ||
      mainHeading.current === null
    ) {
      return;
    }

    mainHeading.current.focus();
    lastFocusedHeading.current = headingFocusKey;
  }, [headingFocusKey]);

  const recordDailyCompletion = useCallback(
    (attemptId: string, source: "solo" | "challenge") => {
      if (loggedDailyCompletions.current.has(attemptId)) {
        return;
      }
      loggedDailyCompletions.current.add(attemptId);
      void logAnalyticsEvent("complete_daily_quiz", { source });
    },
    [],
  );

  const handleComplete = useCallback(async () => {
    if (daily === null) {
      return;
    }

    setBusy(true);
    setActionError(null);
    pendingCompleteKey.current ??= createIdempotencyKey("complete");

    try {
      const completed = await completeAttempt(
        daily.attempt.id,
        pendingCompleteKey.current,
      );
      pendingCompleteKey.current = null;
      recordDailyCompletion(
        daily.attempt.id,
        challengeRole === "opponent" ? "challenge" : "solo",
      );
      setResult(completed);
      setDaily((current) =>
        current === null
          ? current
          : {
              ...current,
              attempt: {
                ...current.attempt,
                status: "completed",
                score: completed.score,
              },
            },
      );
      if (challengeToken !== null && challengeRole === "opponent") {
        try {
          showChallengeResult(await getChallengeResult(challengeToken));
        } catch (challengeError) {
          setActionError(toDisplayError(challengeError));
          setChallengeResult(null);
          setScreen("challenge-waiting");
        }
      } else {
        setScreen("result");
      }
    } catch (error) {
      setActionError(toDisplayError(error));
      setScreen("quiz");
    } finally {
      setBusy(false);
    }
  }, [
    challengeRole,
    challengeToken,
    daily,
    recordDailyCompletion,
    showChallengeResult,
  ]);

  const handleSubmit = useCallback(async () => {
    if (
      daily === null ||
      currentQuestion === undefined ||
      selectedIndex === null
    ) {
      return;
    }

    setBusy(true);
    setActionError(null);

    const existing = pendingAnswer.current;
    const pending =
      existing !== null &&
      existing.sequence === currentQuestion.sequence &&
      existing.revisionId === currentQuestion.revisionId &&
      existing.selectedIndex === selectedIndex
        ? existing
        : {
            key: createIdempotencyKey("answer"),
            sequence: currentQuestion.sequence,
            revisionId: currentQuestion.revisionId,
            selectedIndex,
          };
    pendingAnswer.current = pending;
    if (existing === pending) {
      void logAnalyticsEvent("answer_retry", {
        source: challengeRole === "opponent" ? "challenge" : "solo",
      });
    }

    try {
      const saved = await submitAnswer(
        daily.attempt.id,
        {
          sequence: pending.sequence,
          questionRevisionId: pending.revisionId,
          selectedIndex: pending.selectedIndex,
        },
        pending.key,
      );
      pendingAnswer.current = null;
      setSelectedIndex(null);

      setDaily((current) => {
        if (current === null) {
          return current;
        }
        return {
          ...current,
          attempt: {
            ...current.attempt,
            answeredCount: saved.answeredCount,
            answers: [
              ...current.attempt.answers,
              {
                sequence: pending.sequence,
                questionRevisionId: pending.revisionId,
                selectedIndex: pending.selectedIndex,
              },
            ],
          },
        };
      });

      if (saved.nextSequence === null) {
        window.setTimeout(() => {
          void handleComplete();
        }, 0);
      }
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        (error.code === "ANSWER_ALREADY_SUBMITTED" ||
          error.code === "ANSWER_OUT_OF_ORDER")
      ) {
        pendingAnswer.current = null;

        try {
          const loadedDaily =
            challengeToken !== null && challengeRole === "opponent"
              ? (
                  await claimChallenge(
                    challengeToken,
                    createIdempotencyKey("claim-recovery"),
                  )
                ).daily
              : await startDailyQuiz();
          setDaily(loadedDaily);
          setSelectedIndex(null);
          setResult(null);
          setActionError(null);

          if (loadedDaily.attempt.status === "abandoned") {
            setFatalError(
              toDisplayError(
                new Error(
                  "오늘 퀴즈의 완료 가능 시간이 지났어요. 새 퀴즈를 기다려 주세요.",
                ),
              ),
            );
            setScreen("error");
            return;
          }

          if (
            loadedDaily.attempt.status === "completed" ||
            loadedDaily.attempt.answeredCount === loadedDaily.questions.length
          ) {
            pendingCompleteKey.current ??=
              createIdempotencyKey("complete-recovery");
            const completed = await completeAttempt(
              loadedDaily.attempt.id,
              pendingCompleteKey.current,
            );
            pendingCompleteKey.current = null;
            recordDailyCompletion(
              loadedDaily.attempt.id,
              challengeRole === "opponent" ? "challenge" : "solo",
            );
            setDaily({
              ...loadedDaily,
              attempt: {
                ...loadedDaily.attempt,
                status: "completed",
                score: completed.score,
              },
            });
            setResult(completed);
            if (challengeToken !== null && challengeRole === "opponent") {
              showChallengeResult(await getChallengeResult(challengeToken));
            } else {
              setScreen("result");
            }
          } else {
            setScreen(
              challengeRole === "opponent"
                ? "quiz"
                : loadedDaily.attempt.answeredCount === 0
                  ? "home"
                  : "quiz",
            );
          }
        } catch (recoveryError) {
          setActionError(toDisplayError(recoveryError));
          setScreen("quiz");
        }
      } else {
        setActionError(toDisplayError(error));
      }
    } finally {
      setBusy(false);
    }
  }, [
    challengeRole,
    challengeToken,
    currentQuestion,
    daily,
    handleComplete,
    recordDailyCompletion,
    selectedIndex,
    showChallengeResult,
  ]);

  const handleClaim = useCallback(async () => {
    if (challengeToken === null) {
      return;
    }

    setBusy(true);
    setActionError(null);
    pendingClaimKey.current ??= createIdempotencyKey("claim");

    try {
      const claimed = await claimChallenge(
        challengeToken,
        pendingClaimKey.current,
      );
      pendingClaimKey.current = null;
      setDaily(claimed.daily);
      setResult(null);
      setSelectedIndex(null);
      setChallengeRole("opponent");
      void logAnalyticsEvent("claim_challenge", { role: "opponent" });

      if (
        claimed.challenge.status === "completed" ||
        claimed.daily.attempt.status === "completed"
      ) {
        showChallengeResult(await getChallengeResult(challengeToken));
      } else {
        setScreen("quiz");
      }
    } catch (error) {
      const issue = challengeIssueFromError(error);
      if (issue !== null) {
        pendingClaimKey.current = null;
        void logAnalyticsEvent("claim_conflict", {
          reason: error instanceof ApiClientError ? error.code : "unknown",
        });
        setChallengeIssue(issue);
        setScreen("challenge-issue");
      } else {
        setActionError(toDisplayError(error));
      }
    } finally {
      setBusy(false);
    }
  }, [challengeLanding, challengeToken, showChallengeResult]);

  const handleShareChallenge = useCallback(async () => {
    if (challengeToken === null && (daily === null || result === null)) {
      return;
    }

    const returnScreen = screen;
    setBusy(true);
    setActionError(null);
    setShareMessage(null);
    void logAnalyticsEvent("click_share_challenge", { role: "creator" });

    try {
      let token = challengeToken;
      if (token === null) {
        if (daily === null) {
          return;
        }
        pendingChallengeCreateKey.current ??=
          createIdempotencyKey("create-challenge");
        const created = await createChallenge(
          { attemptId: daily.attempt.id },
          pendingChallengeCreateKey.current,
        );
        pendingChallengeCreateKey.current = null;
        token = created.challenge.token;
        setChallengeToken(token);
        setChallengeRole("creator");
        setChallengeResult(null);
        loggedChallengeCompletion.current = false;
      }

      const outcome = await shareChallenge(token);
      if (outcome === "cancelled") {
        setShareMessage("공유를 취소했어요. 만든 도전장은 그대로 유지돼요.");
        void logAnalyticsEvent("share_challenge_cancelled", {
          role: "creator",
        });
        setScreen(returnScreen);
      } else {
        setShareMessage("도전장을 공유했어요.");
        void logAnalyticsEvent("share_challenge", { role: "creator" });
        setScreen("challenge-waiting");
      }
    } catch (error) {
      setActionError(toDisplayError(error));
      setScreen(returnScreen);
    } finally {
      setBusy(false);
    }
  }, [challengeToken, daily, result, screen]);

  const refreshChallengeResult = useCallback(async () => {
    if (challengeToken === null) {
      return;
    }

    setRefreshingChallenge(true);
    setActionError(null);
    try {
      showChallengeResult(await getChallengeResult(challengeToken));
    } catch (error) {
      const issue = challengeIssueFromError(error);
      if (issue !== null) {
        setChallengeIssue(issue);
        setScreen("challenge-issue");
      } else {
        setActionError(toDisplayError(error));
      }
    } finally {
      setRefreshingChallenge(false);
    }
  }, [challengeToken, showChallengeResult]);

  useEffect(() => {
    if (screen !== "challenge-waiting" || challengeToken === null) {
      return;
    }

    const delays = [2_000, 4_000, 8_000, 15_000, 30_000];
    let active = true;
    let timer: number | null = null;
    let delayIndex = 0;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = () => {
      if (!active || document.hidden) {
        return;
      }
      const delay = delays[Math.min(delayIndex, delays.length - 1)];
      delayIndex += 1;
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      clearTimer();
      if (!active || document.hidden) {
        return;
      }
      try {
        const loadedResult = await getChallengeResult(challengeToken);
        if (!active) {
          return;
        }
        setActionError(null);
        showChallengeResult(loadedResult);
        if (
          loadedResult.status !== "completed" &&
          loadedResult.status !== "redacted"
        ) {
          schedule();
        }
      } catch (error) {
        if (!active) {
          return;
        }
        const issue = challengeIssueFromError(error);
        if (issue !== null) {
          setChallengeIssue(issue);
          setScreen("challenge-issue");
        } else {
          setActionError(toDisplayError(error));
          schedule();
        }
      }
    };
    const handleVisibilityChange = () => {
      clearTimer();
      setPollingPaused(document.hidden);
      if (!document.hidden) {
        delayIndex = 0;
        void poll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (!document.hidden) {
      void poll();
    }

    return () => {
      active = false;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [challengeToken, screen, showChallengeResult]);

  const handleGoToDaily = useCallback(() => {
    setChallengeToken(null);
    setChallengeLanding(null);
    setChallengeResult(null);
    setChallengeRole(null);
    setShareMessage(null);
    pendingClaimKey.current = null;
    pendingChallengeCreateKey.current = null;
    loggedChallengeCompletion.current = false;
    void initializeDaily();
  }, [initializeDaily]);

  const handleOpenSettings = useCallback((returnScreen: "home" | "result") => {
    setSettingsReturnScreen(returnScreen);
    setActionError(null);
    setScreen("settings");
  }, []);

  const loadResultNotificationPreference = useCallback(async () => {
    setNotificationBusy(true);
    setNotificationError(null);

    try {
      const preference = await getResultNotificationPreference();
      setNotificationEnabled(preference.enabled);
    } catch (error) {
      setNotificationEnabled(null);
      setNotificationError(toDisplayError(error));
    } finally {
      setNotificationBusy(false);
    }
  }, []);

  useEffect(() => {
    if (screen !== "settings") {
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      setNotificationBusy(true);
      setNotificationError(null);

      void getResultNotificationPreference()
        .then((preference) => {
          if (active) {
            setNotificationEnabled(preference.enabled);
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setNotificationEnabled(null);
            setNotificationError(toDisplayError(error));
          }
        })
        .finally(() => {
          if (active) {
            setNotificationBusy(false);
          }
        });
    }, 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
      notificationAgreementAbort.current?.abort();
      notificationAgreementAbort.current = null;
    };
  }, [screen]);

  const handleToggleResultNotification = useCallback(async () => {
    if (busy || notificationBusy || notificationEnabled === null) {
      return;
    }

    setNotificationBusy(true);
    setNotificationError(null);

    try {
      let enabled = false;
      let agreementDenied = false;
      if (!notificationEnabled) {
        const controller = new AbortController();
        notificationAgreementAbort.current = controller;
        const agreement = await requestResultNotificationAgreement(
          controller.signal,
        );
        enabled = agreement === "agreed";
        agreementDenied = agreement === "denied";
      }

      const preference = await updateResultNotificationPreference(enabled);
      if (preference.enabled !== enabled) {
        throw new Error("서버가 결과 알림 설정 변경을 확인하지 못했습니다.");
      }
      setNotificationEnabled(preference.enabled);
      if (agreementDenied) {
        setNotificationError({
          title: "알림 동의가 완료되지 않았어요",
          message: "토스 동의 화면에서 거절해 결과 알림을 켜지 않았습니다.",
        });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotificationError(toDisplayError(error));
      }
    } finally {
      notificationAgreementAbort.current = null;
      setNotificationBusy(false);
    }
  }, [busy, notificationBusy, notificationEnabled]);

  const handleDeleteAccount = useCallback(async () => {
    if (busy || notificationBusy || reportPending) {
      return;
    }
    setBusy(true);
    setActionError(null);

    try {
      await deleteAccount({ confirmation: "DELETE" });

      accountDeleted.current = true;
      capturedInitialChallengeToken = null;
      setDaily(null);
      setResult(null);
      setChallengeToken(null);
      setChallengeLanding(null);
      setChallengeResult(null);
      setChallengeRole(null);
      setChallengeIssue("not-found");
      setSelectedIndex(null);
      setSettingsReturnScreen("home");
      setShareMessage(null);
      setFatalError(null);
      setNotificationEnabled(null);
      setNotificationError(null);
      setNotificationBusy(false);
      setRefreshingChallenge(false);
      setPollingPaused(document.hidden);
      pendingAnswer.current = null;
      pendingCompleteKey.current = null;
      pendingChallengeCreateKey.current = null;
      pendingClaimKey.current = null;
      loggedDailyCompletions.current.clear();
      loggedChallengeCompletion.current = false;
      setScreen("deleted");
    } catch (error) {
      setActionError(toDisplayError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, notificationBusy, reportPending]);

  if (screen === "loading") {
    return (
      <LoadingScreen
        headingRef={mainHeading}
        challenge={challengeToken !== null}
      />
    );
  }
  if (screen === "challenge-issue") {
    return (
      <ChallengeIssueScreen
        kind={challengeIssue}
        onToday={handleGoToDaily}
        headingRef={mainHeading}
      />
    );
  }
  if (screen === "challenge-landing" && challengeLanding !== null) {
    return (
      <ChallengeLandingScreen
        landing={challengeLanding}
        onClaim={() => void handleClaim()}
        onToday={handleGoToDaily}
        busy={busy}
        error={actionError}
        headingRef={mainHeading}
      />
    );
  }
  if (screen === "challenge-result" && challengeResult !== null) {
    return (
      <ChallengeResultScreen
        result={challengeResult}
        onToday={handleGoToDaily}
        headingRef={mainHeading}
      />
    );
  }
  if (screen === "challenge-waiting") {
    if (challengeResult === null) {
      const error =
        actionError ??
        ({
          title: "대결 결과를 불러오는 중이에요",
          message: "잠시 후 다시 확인해 주세요.",
        } satisfies DisplayError);
      return (
        <main className="app-shell">
          <section className="card error-card" role="alert">
            <span className="status-icon status-icon-error" aria-hidden="true">
              !
            </span>
            <h1 ref={mainHeading} tabIndex={-1}>
              {error.title}
            </h1>
            <p>{error.message}</p>
            {error.requestId ? (
              <p className="request-id">문의 코드: {error.requestId}</p>
            ) : null}
            <div className="button-stack">
              <button
                className="primary-button"
                onClick={() => void refreshChallengeResult()}
                disabled={refreshingChallenge}
              >
                {refreshingChallenge
                  ? "다시 확인하는 중…"
                  : "대결 결과 다시 확인"}
              </button>
              <button className="secondary-button" onClick={handleGoToDaily}>
                오늘의 퀴즈로 이동
              </button>
            </div>
          </section>
        </main>
      );
    }
    return (
      <ChallengeWaitingScreen
        result={challengeResult}
        paused={pollingPaused}
        refreshing={refreshingChallenge || busy}
        onRefresh={() => void refreshChallengeResult()}
        onShare={
          challengeRole === "creator" ? () => void handleShareChallenge() : null
        }
        onToday={handleGoToDaily}
        error={actionError}
        message={shareMessage}
        headingRef={mainHeading}
      />
    );
  }
  if (screen === "error") {
    return (
      <ErrorPanel
        error={
          fatalError ?? {
            title: "퀴즈를 불러오지 못했어요",
            message: "잠시 후 다시 시도해 주세요.",
          }
        }
        onRetry={() =>
          void (challengeToken === null
            ? initializeDaily()
            : initializeChallenge(challengeToken))
        }
        busy={busy}
        headingRef={mainHeading}
      />
    );
  }
  if (screen === "deleted") {
    return (
      <main className="app-shell">
        <section className="card deleted-card" aria-labelledby="deleted-title">
          <span className="status-icon status-icon-success" aria-hidden="true">
            ✓
          </span>
          <h1 id="deleted-title" ref={mainHeading} tabIndex={-1}>
            계정 삭제 완료
          </h1>
          <p>
            계정과 저장된 기록을 삭제했어요. 앱을 다시 시작하면 새로운 익명
            사용자로 생성됩니다.
          </p>
        </section>
      </main>
    );
  }
  if (screen === "settings") {
    return (
      <AccountSettings
        busy={busy}
        error={actionError}
        headingRef={mainHeading}
        notificationBusy={notificationBusy}
        notificationEnabled={notificationEnabled}
        notificationError={notificationError}
        onCancel={() => {
          setActionError(null);
          setScreen(settingsReturnScreen);
        }}
        onDelete={() => void handleDeleteAccount()}
        onClearError={() => setActionError(null)}
        onReloadNotification={() => void loadResultNotificationPreference()}
        onToggleNotification={() => void handleToggleResultNotification()}
      />
    );
  }
  if (daily === null) {
    return <LoadingScreen headingRef={mainHeading} challenge={false} />;
  }
  if (screen === "home") {
    return (
      <HomeScreen
        daily={daily}
        onStart={() => setScreen("quiz")}
        onSettings={() => handleOpenSettings("home")}
        headingRef={mainHeading}
      />
    );
  }
  if (screen === "result" && result !== null) {
    return (
      <ResultScreen
        daily={daily}
        result={result}
        onRestart={() => void initializeDaily()}
        onSettings={() => handleOpenSettings("result")}
        onShare={() => void handleShareChallenge()}
        onChallengeStatus={() => void refreshChallengeResult()}
        challengeCreated={challengeToken !== null}
        busy={busy || refreshingChallenge}
        actionError={actionError}
        shareMessage={shareMessage}
        reportPending={reportPending}
        onReportPendingChange={setReportPending}
        headingRef={mainHeading}
      />
    );
  }

  return (
    <QuizScreen
      daily={daily}
      selectedIndex={selectedIndex}
      onSelect={(index) => {
        setSelectedIndex(index);
        setActionError(null);
        pendingAnswer.current = null;
      }}
      onSubmit={() => void handleSubmit()}
      onComplete={() => void handleComplete()}
      busy={busy}
      actionError={actionError}
      headingRef={mainHeading}
    />
  );
}

export default App;
