import {
  type ChallengeLandingResponse,
  type ChallengeResultResponse,
  type CompleteAttemptResponse,
  type DailyStartResponse,
} from "@daily-quiz-battle/contracts";
import {
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ApiClientError,
  claimChallenge,
  completeAttempt,
  createChallenge,
  createIdempotencyKey,
  deleteAccount,
  getChallengeLanding,
  getChallengeCapabilities,
  subscribeChallengeCapabilities,
  getChallengeResult,
  getResultNotificationPreference,
  getAuthenticatedUserId,
  isDailySetVoidedError,
  startDailyQuiz,
  updateResultNotificationPreference,
} from "./lib/api";
import {
  ChallengeIssueScreen,
  ChallengeLandingScreen,
  ChallengeResultScreen,
  ChallengeWaitingScreen,
  VoidedResultScreen,
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
import {
  clearDraft,
  clearQuizDateDrafts,
  draftKey,
  newDraft,
  readDraft,
  mutateDraft,
  type QuizDraft,
} from "./lib/quiz-draft";
import {
  isChallengeContextCurrent,
  isDraftForQuizDate,
  runChallengeRequest,
  type ChallengeContext,
} from "./lib/challenge-context";

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
  | "challenge-issue"
  | "voided";

type AvailableDaily = Extract<DailyStartResponse, { status: "available" }>;
type CompletedResult = Extract<
  CompleteAttemptResponse,
  { status: "completed" }
>;
type ActiveChallengeLanding = Exclude<
  ChallengeLandingResponse,
  { status: "voided" }
>;
type ActiveChallengeResult = Exclude<
  ChallengeResultResponse,
  { status: "voided" }
>;

interface DisplayError {
  title: string;
  message: string;
  requestId?: string;
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

function assertNever(value: never): never {
  throw new Error(`처리할 수 없는 응답 상태입니다: ${JSON.stringify(value)}`);
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
  onRetry: (() => void) | null;
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
        {onRetry ? (
          <button className="primary-button" onClick={onRetry} disabled={busy}>
            {busy ? "다시 연결하는 중…" : "다시 시도"}
          </button>
        ) : null}
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
  daily: AvailableDaily | null;
  onStart: () => void;
  onSettings: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const answeredCount = daily?.attempt.answeredCount ?? 0;
  const isResume = answeredCount > 0;

  return (
    <main className="app-shell home-shell">
      <header className="top-bar">
        <div className="brand-lockup">
          <span className="brand-mark brand-mark-small" aria-hidden="true">
            Q
          </span>
          <span>오늘의 상식대결</span>
        </div>
        {daily ? (
          <span className="date-chip">{daily.attempt.quizDate}</span>
        ) : null}
      </header>

      <section className="hero-card" aria-labelledby="home-title">
        <p className="eyebrow">DAILY QUIZ · 5 QUESTIONS</p>
        <h1 id="home-title" ref={headingRef} tabIndex={-1}>
          오늘 5문제,
          <br />
          얼마나
          <br />
          <span>맞힐까요?</span>
        </h1>
        <p className="hero-copy">
          잠깐의 호기심, 오늘의 상식.
          <br />
          모두에게 같은 5문제로 가볍게 시작해요.
        </p>

        <div className="daily-deck" aria-hidden="true">
          <span className="deck-card">
            <small>01</small>
            <b>?</b>
          </span>
          <span className="deck-card">
            <small>02</small>
            <b>?</b>
          </span>
          <span className="deck-card">
            <small>03</small>
            <b>?</b>
          </span>
          <span className="deck-card">
            <small>04</small>
            <b>?</b>
          </span>
          <span className="deck-card">
            <small>05</small>
            <b>Q</b>
          </span>
          <span className="deck-caption">다섯 번의 작은 발견</span>
        </div>

        {isResume ? (
          <div className="resume-box">
            <strong>이전에 서버에 제출한 답 {answeredCount}개</strong>
            <span>이 답들은 유지하고 나머지 답을 선택해 주세요.</span>
          </div>
        ) : (
          <div className="quiz-preview" aria-label="퀴즈 구성">
            <span>5문제</span>
            <span>4지선다</span>
            <span>하루 한 번</span>
          </div>
        )}

        <button
          className="primary-button hero-button"
          onClick={onStart}
          disabled={daily === null}
          aria-busy={daily === null}
        >
          <span aria-live="polite">
            {daily === null
              ? "퀴즈를 연결하고 있어요…"
              : isResume
                ? "이어서 풀기"
                : "오늘 퀴즈 시작"}
          </span>
          <span aria-hidden="true">↗</span>
        </button>
        <button
          className="text-button"
          onClick={onSettings}
          disabled={daily === null}
        >
          계정 설정
        </button>
        <p className="trust-copy">
          답은 기기에 임시 보관하고, 5문제를 최종 제출하면 서버가 점수를
          계산해요.
        </p>
      </section>
    </main>
  );
}

function QuizScreen({
  daily,
  draft,
  onSelect,
  onNavigate,
  onComplete,
  onReload,
  busy,
  actionError,
  storageError,
  headingRef,
}: {
  daily: AvailableDaily;
  draft: QuizDraft;
  onSelect: (index: number) => void;
  onNavigate: (index: number) => void;
  onComplete: () => void;
  onReload: () => void;
  busy: boolean;
  actionError: DisplayError | null;
  storageError: string | null;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const answeredCount = draft.selections.filter(
    (answer) => answer !== null,
  ).length;
  const question = daily.questions[draft.currentQuestion];
  const selectedIndex = draft.selections[draft.currentQuestion];
  const locked = daily.attempt.answers.some(
    (answer) => answer.sequence === question?.sequence,
  );

  if (question === undefined || draft.frozen !== null) {
    return (
      <main className="app-shell">
        <section className="card finishing-card">
          <span className="status-icon status-icon-success" aria-hidden="true">
            ✓
          </span>
          <h1 ref={headingRef} tabIndex={-1}>
            다섯 답을 최종 제출할까요?
          </h1>
          <p>최종 제출하면 서버에서 정답을 확인하고 점수를 계산해요.</p>
          <ol className="draft-review">
            {daily.questions.map((item, index) => (
              <li key={item.revisionId}>
                <strong>
                  {item.sequence}. {item.prompt}
                </strong>
                <span>
                  {draft.selections[index] === null
                    ? "아직 선택하지 않았어요"
                    : item.choices[draft.selections[index]!]}
                </span>
                <button
                  className="text-button"
                  disabled={busy || draft.frozen !== null}
                  onClick={() => onNavigate(index)}
                >
                  답 확인·수정
                </button>
              </li>
            ))}
          </ol>
          {storageError ? (
            <p className="inline-error" role="alert">
              {storageError}
            </p>
          ) : (
            <p className="save-status">기기에 임시 보관</p>
          )}
          {draft.frozen !== null ? (
            <p>
              제출을 시작한 답안은 수정할 수 없어요. 응답을 확인하지 못했다면
              같은 답안으로만 다시 제출합니다.
            </p>
          ) : null}
          {actionError ? (
            <div className="inline-error" role="alert">
              <strong>{actionError.title}</strong>
              <span>{actionError.message}</span>
            </div>
          ) : null}
          <button
            className="primary-button"
            onClick={onComplete}
            disabled={busy || answeredCount !== 5}
          >
            {busy
              ? "최종 제출 중…"
              : draft.frozen
                ? "같은 답안으로 다시 제출"
                : "5문제 최종 제출"}
          </button>
          {draft.frozen ? (
            <button className="text-button" onClick={onReload} disabled={busy}>
              서버 제출 상태 다시 확인
            </button>
          ) : null}
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
        <p className="category-label">
          QUESTION 0{question.sequence} · 오늘의 상식
        </p>
        <h1 id="question-title" ref={headingRef} tabIndex={-1}>
          {question.prompt}
        </h1>

        <fieldset disabled={busy || locked}>
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

        <div className="quiz-navigation">
          <button
            className="secondary-button"
            disabled={busy || draft.currentQuestion === 0}
            onClick={() => onNavigate(draft.currentQuestion - 1)}
          >
            이전
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => onNavigate(draft.currentQuestion + 1)}
          >
            {draft.currentQuestion === 4 ? "답안 검토" : "다음"}
          </button>
        </div>
        <p className="save-status" aria-live="polite">
          {locked
            ? "이전에 서버에 제출한 답은 변경할 수 없어요."
            : "최종 제출 전까지 답을 수정할 수 있어요."}
        </p>
        {storageError ? (
          <p className="inline-error" role="alert">
            {storageError}
          </p>
        ) : (
          <p className="save-status">기기에 임시 보관</p>
        )}
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
  invitationAvailable,
  busy,
  actionError,
  shareMessage,
  reportPending,
  onReportPendingChange,
  headingRef,
}: {
  daily: AvailableDaily;
  result: CompletedResult;
  onRestart: () => void;
  onSettings: () => void;
  onShare: () => void;
  onChallengeStatus: () => void;
  challengeCreated: boolean;
  invitationAvailable: boolean;
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
          className="score-card"
          aria-label={`5문제 중 ${result.score}문제 정답`}
        >
          <strong>{result.score}</strong>
          <span>/ 5</span>
          <small>문제 정답</small>
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
        <strong>
          {invitationAvailable
            ? "친구와 오늘 점수로 대결해 보세요."
            : "오늘의 도전을 마쳤어요."}
        </strong>
        <span>
          {invitationAvailable
            ? "도전장을 받은 친구는 같은 날짜의 같은 5문제를 풀게 돼요."
            : "친구 초대는 현재 이용할 수 없어요. 아래에서 저장된 결과를 확인할 수 있어요."}
        </span>
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
        {invitationAvailable ? (
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
        ) : null}
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
  const challengeCapabilities = useSyncExternalStore(
    subscribeChallengeCapabilities,
    getChallengeCapabilities,
  );
  const invitationAvailable =
    challengeCapabilities.challengeCreateEnabled &&
    challengeCapabilities.challengeClaimEnabled;
  const [screen, setScreen] = useState<Screen>("loading");
  const [daily, setDaily] = useState<AvailableDaily | null>(null);
  const [result, setResult] = useState<CompletedResult | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(
    takeInitialChallengeToken,
  );
  const activeChallengeToken = useRef(challengeToken);
  const [challengeLanding, setChallengeLanding] =
    useState<ActiveChallengeLanding | null>(null);
  const [challengeResult, setChallengeResult] =
    useState<ActiveChallengeResult | null>(null);
  const [challengeRole, setChallengeRole] = useState<
    "creator" | "opponent" | null
  >(null);
  const [challengeIssue, setChallengeIssue] =
    useState<ChallengeIssueKind>("not-found");
  const [draft, setDraft] = useState<QuizDraft | null>(null);
  const draftRef = useRef<QuizDraft | null>(null);
  const activeQuizDate = useRef<string | null>(null);
  const submitting = useRef(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingChallenge, setRefreshingChallenge] = useState(false);
  const [pollingPaused, setPollingPaused] = useState(document.hidden);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<DisplayError | null>(null);
  const [actionError, setActionError] = useState<DisplayError | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState<
    boolean | null
  >(null);
  const [notificationDeliveryAvailable, setNotificationDeliveryAvailable] =
    useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [reportPending, setReportPending] = useState(false);
  const [notificationError, setNotificationError] =
    useState<DisplayError | null>(null);
  const [settingsReturnScreen, setSettingsReturnScreen] = useState<
    "home" | "result"
  >("home");
  const accountDeleted = useRef(false);
  const deletingAccount = useRef(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const initialChallengeToken = useRef(challengeToken);
  const initializationGeneration = useRef(0);
  const initializationAbort = useRef<AbortController | null>(null);
  const challengeRefreshGeneration = useRef(0);
  const challengeRefreshAbort = useRef<AbortController | null>(null);
  const pendingChallengeCreateKey = useRef<string | null>(null);
  const pendingClaimKey = useRef<string | null>(null);
  const notificationAgreementAbort = useRef<AbortController | null>(null);
  const loggedDailyCompletions = useRef(new Set<string>());
  const loggedChallengeCompletion = useRef(false);
  const completionAnalyticsBlocked = useRef(false);
  const mainHeading = useRef<HTMLHeadingElement>(null);
  const lastFocusedHeading = useRef<string | null>(null);

  const readChallengeContext = useCallback(
    (requestGeneration = 0): ChallengeContext => ({
      generation: initializationGeneration.current,
      requestGeneration,
      userId: getAuthenticatedUserId(),
      token: activeChallengeToken.current,
      quizDate: activeQuizDate.current,
      accountDeleted: accountDeleted.current,
    }),
    [],
  );

  const invalidateChallengeRefresh = useCallback(() => {
    challengeRefreshGeneration.current += 1;
    challengeRefreshAbort.current?.abort();
    challengeRefreshAbort.current = null;
    setRefreshingChallenge(false);
  }, []);

  const discardDraft = useCallback(() => {
    const current = draftRef.current;
    const generation = initializationGeneration.current;
    draftRef.current = null;
    setDraft(null);
    if (current !== null) {
      void clearDraft(current).catch((error: unknown) => {
        if (
          !accountDeleted.current &&
          generation === initializationGeneration.current
        )
          setStorageError(toDisplayError(error).message);
      });
    }
  }, []);

  const discardDateDrafts = useCallback(
    (quizDate: string) => {
      const context = readChallengeContext();
      if (isDraftForQuizDate(draftRef.current, context.userId, quizDate)) {
        draftRef.current = null;
        setDraft(null);
      }
      if (context.userId !== null) {
        void clearQuizDateDrafts(context.userId, quizDate).catch(
          (error: unknown) => {
            if (isChallengeContextCurrent(context, readChallengeContext()))
              setStorageError(toDisplayError(error).message);
          },
        );
      }
    },
    [readChallengeContext],
  );

  const hydrateDraft = useCallback(async (loaded: AvailableDaily) => {
    const userId = getAuthenticatedUserId();
    if (userId === null || accountDeleted.current) return;
    const generation = initializationGeneration.current;
    const isCurrent = () =>
      !accountDeleted.current &&
      generation === initializationGeneration.current &&
      userId === getAuthenticatedUserId();
    const base = newDraft(userId, loaded);
    activeQuizDate.current = loaded.attempt.quizDate;
    draftRef.current = null;
    setDraft(null);
    setStorageError(null);
    try {
      if (loaded.attempt.status !== "started") {
        await clearDraft(base);
        return;
      }
      const restored = await mutateDraft(
        base,
        (stored) => {
          const next = stored ?? base;
          const selections = [...next.selections];
          for (const answer of loaded.attempt.answers)
            selections[answer.sequence - 1] = answer.selectedIndex;
          return { ...next, selections };
        },
        isCurrent,
      );
      if (!isCurrent()) return;
      draftRef.current = restored;
      setDraft(restored);
    } catch (error) {
      if (isCurrent()) setStorageError(toDisplayError(error).message);
    }
  }, []);

  const updateDraft = useCallback(
    async (attemptId: string, change: (current: QuizDraft) => QuizDraft) => {
      const current = draftRef.current;
      const generation = initializationGeneration.current;
      const isCurrent = () =>
        !accountDeleted.current &&
        generation === initializationGeneration.current &&
        current?.userId === getAuthenticatedUserId() &&
        draftRef.current?.attemptId === attemptId;
      if (
        current === null ||
        submitting.current ||
        current.attemptId !== attemptId ||
        current.frozen !== null ||
        !isCurrent()
      )
        return;
      try {
        const updated = await mutateDraft(
          current,
          (stored) => {
            if (stored === null)
              throw new Error(
                "기기의 답안이 삭제됐어요. 서버에서 최신 상태를 다시 확인해 주세요.",
              );
            return change(stored);
          },
          isCurrent,
        );
        if (!isCurrent()) return;
        draftRef.current = updated;
        setDraft(updated);
        setStorageError(null);
        setActionError(null);
      } catch (error) {
        if (isCurrent()) setStorageError(toDisplayError(error).message);
      }
    },
    [],
  );

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      const current = draftRef.current;
      if (
        deletingAccount.current ||
        accountDeleted.current ||
        current === null ||
        (event.key !== null && event.key !== draftKey(current))
      )
        return;
      // Remote removal can mean completion or deletion; never recreate that draft.
      if (
        event.newValue === null ||
        getAuthenticatedUserId() !== current.userId
      ) {
        draftRef.current = null;
        setDraft(null);
        initializationGeneration.current += 1;
        invalidateChallengeRefresh();
        setFatalError({
          title: "기기의 답안 상태가 변경됐어요",
          message: "서버에서 최신 상태를 다시 확인해 주세요.",
        });
        setScreen("error");
        return;
      }
      try {
        const stored = readDraft(current);
        if (stored !== null) {
          if (
            current.frozen !== null &&
            JSON.stringify(current.frozen) !== JSON.stringify(stored.frozen)
          ) {
            setStorageError(
              "다른 창에서 답안 상태가 변경됐어요. 제출한 답은 유지하며 서버 제출 상태를 다시 확인해야 해요.",
            );
            return;
          }
          draftRef.current = stored;
          setDraft(stored);
        }
      } catch (error) {
        setStorageError(toDisplayError(error).message);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [invalidateChallengeRefresh]);

  const showVoidedResult = useCallback(
    (quizDate?: string) => {
      const date = quizDate ?? activeQuizDate.current;
      invalidateChallengeRefresh();
      initializationAbort.current?.abort();
      initializationAbort.current = null;
      initializationGeneration.current += 1;
      completionAnalyticsBlocked.current = true;
      setDaily(null);
      setResult(null);
      activeChallengeToken.current = null;
      setChallengeToken(null);
      if (date !== null) discardDateDrafts(date);
      setChallengeLanding(null);
      setChallengeResult(null);
      setChallengeRole(null);
      setShareMessage(null);
      setFatalError(null);
      setActionError(null);
      setReportPending(false);
      setPollingPaused(true);
      pendingChallengeCreateKey.current = null;
      pendingClaimKey.current = null;
      setBusy(false);
      setScreen("voided");
    },
    [discardDateDrafts, invalidateChallengeRefresh],
  );

  const showChallengeResult = useCallback(
    (loadedResult: ChallengeResultResponse) => {
      switch (loadedResult.status) {
        case "voided":
          showVoidedResult(loadedResult.quizDate);
          return;
        case "completed":
          discardDateDrafts(loadedResult.quizDate);
          setChallengeResult(loadedResult);
          setChallengeRole(loadedResult.viewerRole);
          if (
            !completionAnalyticsBlocked.current &&
            !loggedChallengeCompletion.current
          ) {
            loggedChallengeCompletion.current = true;
            void logAnalyticsEvent("complete_challenge", {
              role: loadedResult.viewerRole,
              outcome: loadedResult.outcome,
            });
          }
          setScreen("challenge-result");
          return;
        case "redacted":
          setChallengeResult(loadedResult);
          setChallengeRole(loadedResult.viewerRole);
          setScreen("challenge-result");
          return;
        case "open":
        case "claimed":
          setChallengeResult(loadedResult);
          setChallengeRole(loadedResult.viewerRole);
          setPollingPaused(document.hidden);
          setScreen("challenge-waiting");
          return;
        default:
          assertNever(loadedResult);
      }
    },
    [discardDateDrafts, showVoidedResult],
  );

  const initializeDaily = useCallback(async () => {
    invalidateChallengeRefresh();
    initializationAbort.current?.abort();
    const controller = new AbortController();
    initializationAbort.current = controller;
    const generation = ++initializationGeneration.current;
    activeQuizDate.current = null;
    draftRef.current = null;
    setDraft(null);
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
      switch (loadedDaily.status) {
        case "voided":
          showVoidedResult(loadedDaily.quizDate);
          return;
        case "available":
          completionAnalyticsBlocked.current = false;
          setDaily(loadedDaily);
          break;
        default:
          assertNever(loadedDaily);
      }
      await hydrateDraft(loadedDaily);
      if (!isCurrent()) return;

      if (loadedDaily.attempt.status === "abandoned") {
        throw new Error(
          "오늘 퀴즈의 완료 가능 시간이 지났어요. 새 퀴즈를 기다려 주세요.",
        );
      }

      if (loadedDaily.attempt.status === "completed") {
        if (loadedDaily.completedResult === undefined) {
          throw new Error(
            "저장된 결과를 불러오지 못했어요. 다시 시도해 주세요.",
          );
        }
        setResult(loadedDaily.completedResult);
        setScreen("result");
      } else {
        setResult(null);
        setScreen("home");
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      if (isDailySetVoidedError(error)) {
        showVoidedResult();
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
  }, [hydrateDraft, invalidateChallengeRefresh, showVoidedResult]);

  const initializeChallenge = useCallback(
    async (token: string) => {
      invalidateChallengeRefresh();
      initializationAbort.current?.abort();
      const controller = new AbortController();
      initializationAbort.current = controller;
      const generation = ++initializationGeneration.current;
      activeQuizDate.current = null;
      draftRef.current = null;
      setDraft(null);
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
        activeQuizDate.current = landing.quizDate;
        switch (landing.status) {
          case "voided":
            showVoidedResult(landing.quizDate);
            return;
          case "expired":
            setChallengeLanding(landing);
            setChallengeIssue("expired");
            setScreen("challenge-issue");
            return;
          case "open":
          case "claimed":
          case "completed":
            completionAnalyticsBlocked.current = false;
            setChallengeLanding(landing);
            break;
          default:
            assertNever(landing);
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
          await hydrateDraft(resumed.daily);
          if (!isCurrent()) return;
          if (resumed.daily.attempt.status === "abandoned") {
            setChallengeIssue("expired");
            setScreen("challenge-issue");
            return;
          }
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
        if (isDailySetVoidedError(error)) {
          showVoidedResult();
          return;
        }
        const issue = challengeIssueFromError(error);
        if (issue !== null) {
          if (
            error instanceof ApiClientError &&
            error.code === "ATTEMPT_ABANDONED" &&
            activeQuizDate.current !== null
          ) {
            discardDateDrafts(activeQuizDate.current);
          }
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
    [
      discardDateDrafts,
      hydrateDraft,
      invalidateChallengeRefresh,
      showChallengeResult,
      showVoidedResult,
    ],
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
      challengeRefreshAbort.current?.abort();
      challengeRefreshAbort.current = null;
      challengeRefreshGeneration.current += 1;
    };
  }, [initializeChallenge, initializeDaily]);

  const currentQuestion = draft?.frozen
    ? undefined
    : daily?.questions[draft?.currentQuestion ?? 0];
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
      if (
        completionAnalyticsBlocked.current ||
        loggedDailyCompletions.current.has(attemptId)
      ) {
        return;
      }
      loggedDailyCompletions.current.add(attemptId);
      void logAnalyticsEvent("complete_daily_quiz", { source });
    },
    [],
  );

  const handleComplete = useCallback(async () => {
    const current = draftRef.current;
    if (
      daily === null ||
      current === null ||
      submitting.current ||
      accountDeleted.current ||
      current.userId !== getAuthenticatedUserId() ||
      current.attemptId !== daily.attempt.id ||
      current.selections.some((answer) => answer === null)
    )
      return;
    const generation = initializationGeneration.current;
    const isCurrent = () =>
      !accountDeleted.current &&
      generation === initializationGeneration.current &&
      getAuthenticatedUserId() === current.userId &&
      draftRef.current?.attemptId === current.attemptId;
    submitting.current = true;
    setBusy(true);
    setActionError(null);
    try {
      if (!navigator.locks)
        throw new Error(
          "안전한 최종 제출을 위해 최신 브라우저에서 다시 열어 주세요.",
        );
      const locked = await mutateDraft(
        current,
        (stored) => {
          if (stored === null)
            throw new Error(
              "기기의 답안이 삭제됐어요. 서버에서 최신 제출 상태를 다시 확인해 주세요.",
            );
          const snapshot = stored;
          if (snapshot.selections.some((answer) => answer === null))
            throw new Error("다섯 답을 모두 선택한 뒤 최종 제출해 주세요.");
          const frozen = snapshot.frozen ?? {
            key: createIdempotencyKey("complete"),
            answers: snapshot.selections.map((selectedIndex, index) => ({
              sequence: index + 1,
              questionRevisionId: snapshot.revisions[index]!,
              selectedIndex: selectedIndex!,
            })),
          };
          const frozenDraft = { ...snapshot, currentQuestion: 5, frozen };
          // Serialize competing tabs and persist the exact request before HTTP.
          return frozenDraft;
        },
        isCurrent,
      );
      if (!isCurrent()) return;
      const frozen = locked.frozen;
      if (frozen === null)
        throw new Error("최종 답안을 임시 보관하지 못했어요.");
      draftRef.current = locked;
      setDraft(locked);
      setStorageError(null);
      const completed = await completeAttempt(
        current.attemptId,
        { answers: frozen.answers },
        frozen.key,
      );
      if (!isCurrent()) return;
      if (completed.status === "voided") {
        showVoidedResult();
        return;
      }
      discardDraft();
      setResult(completed);
      setDaily({
        ...daily,
        completedResult: completed,
        attempt: {
          ...daily.attempt,
          status: "completed",
          answeredCount: 5,
          answers: frozen.answers,
          score: completed.score,
        },
      });
      if (challengeToken !== null && challengeRole === "opponent") {
        try {
          const loaded = await getChallengeResult(challengeToken);
          if (
            accountDeleted.current ||
            generation !== initializationGeneration.current ||
            getAuthenticatedUserId() !== current.userId
          )
            return;
          showChallengeResult(loaded);
          recordDailyCompletion(current.attemptId, "challenge");
        } catch (error) {
          if (
            accountDeleted.current ||
            generation !== initializationGeneration.current ||
            getAuthenticatedUserId() !== current.userId
          )
            return;
          if (isDailySetVoidedError(error)) {
            showVoidedResult();
            return;
          }
          setActionError(toDisplayError(error));
          setChallengeResult(null);
          setScreen("challenge-waiting");
        }
      } else {
        recordDailyCompletion(current.attemptId, "solo");
        setScreen("result");
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (isDailySetVoidedError(error)) {
        showVoidedResult();
        return;
      }
      if (
        error instanceof ApiClientError &&
        error.code === "ATTEMPT_ABANDONED"
      ) {
        discardDraft();
        setFatalError(toDisplayError(error));
        setScreen("error");
        return;
      }
      // Conflicting server records must be reloaded, never overwritten locally.
      if (
        error instanceof ApiClientError &&
        (error.code === "ATTEMPT_ALREADY_COMPLETED" ||
          error.code === "SAVED_ANSWER_CONFLICT")
      ) {
        if (challengeToken !== null && challengeRole === "opponent")
          await initializeChallenge(challengeToken);
        else await initializeDaily();
        return;
      }
      setActionError(toDisplayError(error));
      if (!(error instanceof ApiClientError))
        setStorageError(toDisplayError(error).message);
      setScreen("quiz");
    } finally {
      submitting.current = false;
      if (
        !accountDeleted.current &&
        generation === initializationGeneration.current
      )
        setBusy(false);
    }
  }, [
    challengeRole,
    challengeToken,
    daily,
    discardDraft,
    initializeChallenge,
    initializeDaily,
    recordDailyCompletion,
    showChallengeResult,
    showVoidedResult,
  ]);

  const handleClaim = useCallback(async () => {
    if (challengeToken === null) {
      return;
    }
    const generation = initializationGeneration.current;
    const userId = getAuthenticatedUserId();
    const isCurrent = () =>
      !accountDeleted.current &&
      generation === initializationGeneration.current &&
      userId === getAuthenticatedUserId();

    setBusy(true);
    setActionError(null);
    pendingClaimKey.current ??= createIdempotencyKey("claim");

    try {
      const claimed = await claimChallenge(
        challengeToken,
        pendingClaimKey.current,
      );
      if (!isCurrent() || completionAnalyticsBlocked.current) {
        return;
      }
      pendingClaimKey.current = null;
      setDaily(claimed.daily);
      setResult(null);
      await hydrateDraft(claimed.daily);
      if (!isCurrent()) return;
      setChallengeRole("opponent");
      void logAnalyticsEvent("claim_challenge", { role: "opponent" });

      if (claimed.daily.attempt.status === "abandoned") {
        setChallengeIssue("expired");
        setScreen("challenge-issue");
      } else if (
        claimed.challenge.status === "completed" ||
        claimed.daily.attempt.status === "completed"
      ) {
        const loaded = await getChallengeResult(challengeToken);
        if (isCurrent()) showChallengeResult(loaded);
      } else {
        setScreen("quiz");
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (isDailySetVoidedError(error)) {
        showVoidedResult();
        return;
      }
      const issue = challengeIssueFromError(error);
      if (issue !== null) {
        pendingClaimKey.current = null;
        if (
          error instanceof ApiClientError &&
          error.code === "ATTEMPT_ABANDONED" &&
          activeQuizDate.current !== null
        ) {
          discardDateDrafts(activeQuizDate.current);
        }
        void logAnalyticsEvent("claim_conflict", {
          reason: error instanceof ApiClientError ? error.code : "unknown",
        });
        setChallengeIssue(issue);
        setScreen("challenge-issue");
      } else {
        setActionError(toDisplayError(error));
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [
    challengeToken,
    discardDateDrafts,
    hydrateDraft,
    showChallengeResult,
    showVoidedResult,
  ]);

  const handleShareChallenge = useCallback(async () => {
    const availability = getChallengeCapabilities();
    if (
      !availability.challengeCreateEnabled ||
      !availability.challengeClaimEnabled
    ) {
      setShareMessage("친구 초대는 현재 이용할 수 없어요.");
      return;
    }
    if (challengeToken === null && (daily === null || result === null)) {
      return;
    }

    let context = readChallengeContext();
    const isCurrent = () =>
      isChallengeContextCurrent(context, readChallengeContext());
    if (context.accountDeleted || context.token !== challengeToken) return;
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
        if (!isCurrent() || completionAnalyticsBlocked.current) {
          return;
        }
        pendingChallengeCreateKey.current = null;
        token = created.challenge.token;
        activeChallengeToken.current = token;
        setChallengeToken(token);
        context = readChallengeContext();
        setChallengeRole("creator");
        setChallengeResult(null);
        loggedChallengeCompletion.current = false;
      }

      const outcome = await shareChallenge(token);
      if (!isCurrent() || completionAnalyticsBlocked.current) {
        return;
      }
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
      if (!isCurrent()) return;
      if (isDailySetVoidedError(error)) {
        showVoidedResult();
        return;
      }
      setActionError(toDisplayError(error));
      setScreen(returnScreen);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [
    challengeToken,
    daily,
    readChallengeContext,
    result,
    screen,
    showVoidedResult,
  ]);

  const refreshChallengeResult = useCallback(async () => {
    if (
      challengeToken === null ||
      activeChallengeToken.current !== challengeToken ||
      accountDeleted.current
    ) {
      return;
    }

    challengeRefreshAbort.current?.abort();
    const controller = new AbortController();
    challengeRefreshAbort.current = controller;
    const context = readChallengeContext(++challengeRefreshGeneration.current);
    setRefreshingChallenge(true);
    setActionError(null);
    await runChallengeRequest({
      request: () => getChallengeResult(challengeToken, controller.signal),
      isCurrent: () =>
        isChallengeContextCurrent(
          context,
          readChallengeContext(challengeRefreshGeneration.current),
        ),
      onResult: showChallengeResult,
      onError: (error) => {
        if (isDailySetVoidedError(error)) {
          showVoidedResult(context.quizDate ?? undefined);
          return;
        }
        const issue = challengeIssueFromError(error);
        if (issue !== null) {
          setChallengeIssue(issue);
          setScreen("challenge-issue");
        } else {
          setActionError(toDisplayError(error));
        }
      },
      onFinally: () => {
        challengeRefreshAbort.current = null;
        setRefreshingChallenge(false);
      },
    });
  }, [
    challengeToken,
    readChallengeContext,
    showChallengeResult,
    showVoidedResult,
  ]);

  useEffect(() => {
    if (screen !== "challenge-waiting" || challengeToken === null) {
      return;
    }

    const delays = [2_000, 4_000, 8_000, 15_000, 30_000];
    let active = true;
    const pollingContext = readChallengeContext();
    let timer: number | null = null;
    let requestController: AbortController | null = null;
    let delayIndex = 0;

    const isActive = () =>
      active &&
      activeChallengeToken.current === challengeToken &&
      isChallengeContextCurrent(pollingContext, readChallengeContext());
    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = () => {
      if (!isActive() || document.hidden) {
        return;
      }
      const delay = delays[Math.min(delayIndex, delays.length - 1)];
      delayIndex += 1;
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      clearTimer();
      if (!isActive() || document.hidden) {
        return;
      }
      if (challengeRefreshAbort.current !== null) {
        schedule();
        return;
      }
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      const context = readChallengeContext(challengeRefreshGeneration.current);
      const isCurrent = () =>
        isActive() &&
        requestController === controller &&
        isChallengeContextCurrent(
          context,
          readChallengeContext(challengeRefreshGeneration.current),
        );
      try {
        const loadedResult = await getChallengeResult(
          challengeToken,
          controller.signal,
        );
        if (!isCurrent()) {
          if (active && requestController === controller) schedule();
          return;
        }
        setActionError(null);
        showChallengeResult(loadedResult);
        switch (loadedResult.status) {
          case "open":
          case "claimed":
            schedule();
            break;
          case "completed":
          case "redacted":
          case "voided":
            break;
          default:
            assertNever(loadedResult);
        }
      } catch (error) {
        if (!isCurrent()) {
          if (active && requestController === controller) schedule();
          return;
        }
        if (
          document.hidden ||
          (error instanceof ApiClientError && error.code === "REQUEST_ABORTED")
        ) {
          return;
        }
        if (isDailySetVoidedError(error)) {
          showVoidedResult(context.quizDate ?? undefined);
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
      } finally {
        if (requestController === controller) {
          requestController = null;
        }
      }
    };
    const handleVisibilityChange = () => {
      if (!isActive()) return;
      clearTimer();
      if (document.hidden) {
        requestController?.abort();
        requestController = null;
      }
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
      requestController?.abort();
      requestController = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    challengeToken,
    readChallengeContext,
    screen,
    showChallengeResult,
    showVoidedResult,
  ]);

  useEffect(() => {
    if (screen !== "result") {
      return;
    }

    let active = true;
    let requestController: AbortController | null = null;

    const revalidateDaily = async () => {
      if (!active || document.hidden || requestController !== null) {
        return;
      }

      const controller = new AbortController();
      requestController = controller;
      const context = readChallengeContext();
      const isCurrent = () =>
        active &&
        requestController === controller &&
        isChallengeContextCurrent(context, readChallengeContext());
      try {
        const loadedDaily = await startDailyQuiz(controller.signal);
        if (!isCurrent()) {
          return;
        }
        switch (loadedDaily.status) {
          case "voided":
            showVoidedResult(loadedDaily.quizDate);
            break;
          case "available":
            break;
          default:
            assertNever(loadedDaily);
        }
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        if (isDailySetVoidedError(error)) {
          showVoidedResult(context.quizDate ?? undefined);
        }
      } finally {
        if (requestController === controller) {
          requestController = null;
        }
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        requestController?.abort();
        requestController = null;
        return;
      }
      void revalidateDaily();
    };
    const handleFocus = () => {
      void revalidateDaily();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      active = false;
      requestController?.abort();
      requestController = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [readChallengeContext, screen, showVoidedResult]);

  const handleGoToDaily = useCallback(() => {
    activeChallengeToken.current = null;
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
    const generation = initializationGeneration.current;
    const isCurrent = () =>
      !accountDeleted.current &&
      !deletingAccount.current &&
      generation === initializationGeneration.current;
    setNotificationBusy(true);
    setNotificationError(null);

    try {
      const preference = await getResultNotificationPreference();
      if (!isCurrent()) return;
      setNotificationEnabled(preference.enabled);
      setNotificationDeliveryAvailable(preference.deliveryAvailable);
    } catch (error) {
      if (!isCurrent()) return;
      setNotificationEnabled(null);
      setNotificationDeliveryAvailable(false);
      setNotificationError(toDisplayError(error));
    } finally {
      if (isCurrent()) setNotificationBusy(false);
    }
  }, []);

  useEffect(() => {
    if (screen !== "settings") {
      return;
    }

    let active = true;
    const generation = initializationGeneration.current;
    const isCurrent = () =>
      active &&
      !accountDeleted.current &&
      !deletingAccount.current &&
      generation === initializationGeneration.current;
    const timer = window.setTimeout(() => {
      if (!isCurrent()) return;
      setNotificationBusy(true);
      setNotificationError(null);

      void getResultNotificationPreference()
        .then((preference) => {
          if (isCurrent()) {
            setNotificationEnabled(preference.enabled);
            setNotificationDeliveryAvailable(preference.deliveryAvailable);
          }
        })
        .catch((error: unknown) => {
          if (isCurrent()) {
            setNotificationEnabled(null);
            setNotificationDeliveryAvailable(false);
            setNotificationError(toDisplayError(error));
          }
        })
        .finally(() => {
          if (isCurrent()) {
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
    if (
      busy ||
      notificationBusy ||
      notificationEnabled === null ||
      (!notificationEnabled && !notificationDeliveryAvailable)
    ) {
      return;
    }

    const generation = initializationGeneration.current;
    const isCurrent = () =>
      !accountDeleted.current &&
      !deletingAccount.current &&
      generation === initializationGeneration.current;
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
        if (!isCurrent()) return;
        enabled = agreement === "agreed";
        agreementDenied = agreement === "denied";
      }

      const preference = await updateResultNotificationPreference(enabled);
      if (!isCurrent()) return;
      if (preference.enabled !== enabled) {
        throw new Error("서버가 결과 알림 설정 변경을 확인하지 못했습니다.");
      }
      setNotificationEnabled(preference.enabled);
      setNotificationDeliveryAvailable(preference.deliveryAvailable);
      if (agreementDenied) {
        setNotificationError({
          title: "알림 동의가 완료되지 않았어요",
          message: "토스 동의 화면에서 거절해 결과 알림을 켜지 않았습니다.",
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      setNotificationDeliveryAvailable(false);
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotificationError(toDisplayError(error));
      }
    } finally {
      if (isCurrent()) {
        notificationAgreementAbort.current = null;
        setNotificationBusy(false);
      }
    }
  }, [
    busy,
    notificationBusy,
    notificationEnabled,
    notificationDeliveryAvailable,
  ]);

  const handleDeleteAccount = useCallback(async () => {
    if (
      busy ||
      notificationBusy ||
      reportPending ||
      deletingAccount.current ||
      accountDeleted.current
    ) {
      return;
    }
    const preservedDraft = draftRef.current;
    deletingAccount.current = true;
    setBusy(true);
    setActionError(null);
    invalidateChallengeRefresh();
    initializationAbort.current?.abort();
    initializationAbort.current = null;
    notificationAgreementAbort.current?.abort();
    notificationAgreementAbort.current = null;
    initializationGeneration.current += 1;

    try {
      await deleteAccount({ confirmation: "DELETE" });

      accountDeleted.current = true;
      setSessionEnded(true);
      draftRef.current = null;
      setDraft(null);
      capturedInitialChallengeToken = null;
      setDaily(null);
      setResult(null);
      activeChallengeToken.current = null;
      setChallengeToken(null);
      setChallengeLanding(null);
      setChallengeResult(null);
      setChallengeRole(null);
      setChallengeIssue("not-found");
      setSettingsReturnScreen("home");
      setShareMessage(null);
      setFatalError(null);
      setNotificationEnabled(null);
      setNotificationDeliveryAvailable(false);
      setNotificationError(null);
      setNotificationBusy(false);
      setRefreshingChallenge(false);
      setPollingPaused(document.hidden);
      pendingChallengeCreateKey.current = null;
      pendingClaimKey.current = null;
      loggedDailyCompletions.current.clear();
      loggedChallengeCompletion.current = false;
      completionAnalyticsBlocked.current = true;
      setScreen("deleted");
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        (error.code === "ACCOUNT_DELETION_OUTCOME_UNKNOWN" ||
          error.code === "ACCOUNT_DELETION_IDENTITY_CHANGED" ||
          error.code === "ACCOUNT_DELETED_LOCAL_CLEANUP_FAILED")
      ) {
        accountDeleted.current = true;
        setSessionEnded(true);
        setDaily(null);
        setResult(null);
        setFatalError(toDisplayError(error));
        setScreen("error");
      } else if (preservedDraft !== null) {
        try {
          // Another tab may have saved or frozen while DELETE was rejected.
          // Restore that durable snapshot without creating a new attempt/key.
          const restored = readDraft(preservedDraft);
          draftRef.current = restored;
          setDraft(restored);
          if (restored === null)
            setStorageError(
              "기기의 답안 상태가 변경됐어요. 서버에서 최신 상태를 다시 확인해 주세요.",
            );
        } catch (storageFailure) {
          setStorageError(toDisplayError(storageFailure).message);
        }
      }
      setActionError(toDisplayError(error));
    } finally {
      deletingAccount.current = false;
      setBusy(false);
    }
  }, [busy, invalidateChallengeRefresh, notificationBusy, reportPending]);

  if (screen === "loading") {
    if (challengeToken === null) {
      return (
        <HomeScreen
          daily={null}
          onStart={() => setScreen("quiz")}
          onSettings={() => handleOpenSettings("home")}
          headingRef={mainHeading}
        />
      );
    }
    return (
      <LoadingScreen
        headingRef={mainHeading}
        challenge={challengeToken !== null}
      />
    );
  }
  if (screen === "voided") {
    return (
      <>
        {storageError ? (
          <p className="inline-error" role="alert">
            {storageError}
          </p>
        ) : null}
        <VoidedResultScreen
          onToday={handleGoToDaily}
          headingRef={mainHeading}
        />
      </>
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
  if (
    screen === "challenge-result" &&
    challengeResult !== null &&
    (challengeResult.status === "completed" ||
      challengeResult.status === "redacted")
  ) {
    return (
      <>
        {storageError ? (
          <p className="inline-error" role="alert">
            {storageError}
          </p>
        ) : null}
        <ChallengeResultScreen
          result={challengeResult}
          onToday={handleGoToDaily}
          headingRef={mainHeading}
        />
      </>
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
    if (
      challengeResult.status === "completed" ||
      challengeResult.status === "redacted"
    ) {
      return (
        <ChallengeResultScreen
          result={challengeResult}
          onToday={handleGoToDaily}
          headingRef={mainHeading}
        />
      );
    }
    return (
      <ChallengeWaitingScreen
        result={challengeResult}
        paused={pollingPaused}
        refreshing={refreshingChallenge || busy}
        onRefresh={() => void refreshChallengeResult()}
        onShare={
          challengeRole === "creator" && invitationAvailable
            ? () => void handleShareChallenge()
            : null
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
        onRetry={
          sessionEnded
            ? null
            : () =>
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
        notificationDeliveryAvailable={notificationDeliveryAvailable}
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
        invitationAvailable={invitationAvailable}
        busy={busy || refreshingChallenge}
        actionError={
          actionError ??
          (storageError
            ? { title: "기기 저장 공간을 확인해 주세요", message: storageError }
            : null)
        }
        shareMessage={shareMessage}
        reportPending={reportPending}
        onReportPendingChange={setReportPending}
        headingRef={mainHeading}
      />
    );
  }

  if (draft === null) {
    return (
      <ErrorPanel
        error={{
          title: "답안을 다시 확인해 주세요",
          message:
            storageError ?? "서버에서 최신 상태를 불러와야 계속할 수 있어요.",
        }}
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

  return (
    <QuizScreen
      daily={daily}
      draft={draft}
      onSelect={(index) => {
        updateDraft(daily.attempt.id, (current) => {
          if (
            daily.attempt.answers.some(
              (answer) => answer.sequence === current.currentQuestion + 1,
            )
          )
            return current;
          const selections = [...current.selections];
          selections[current.currentQuestion] = index;
          return { ...current, selections };
        });
      }}
      onNavigate={(index) =>
        updateDraft(daily.attempt.id, (current) => ({
          ...current,
          currentQuestion: index,
        }))
      }
      onComplete={() => void handleComplete()}
      onReload={() =>
        void (challengeToken === null
          ? initializeDaily()
          : initializeChallenge(challengeToken))
      }
      busy={busy}
      actionError={actionError}
      storageError={storageError}
      headingRef={mainHeading}
    />
  );
}

export default App;
