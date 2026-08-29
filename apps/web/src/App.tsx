import {
  type CompleteAttemptResponse,
  type DailyStartResponse,
  type PublicQuestion,
} from "@daily-quiz-battle/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiClientError,
  completeAttempt,
  createIdempotencyKey,
  startDailyQuiz,
  submitAnswer,
} from "./lib/api";
import "./App.css";

type Screen = "loading" | "home" | "quiz" | "result" | "error";

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

function LoadingScreen() {
  return (
    <main className="app-shell" aria-busy="true">
      <section className="card loading-card" aria-labelledby="loading-title">
        <div className="brand-mark" aria-hidden="true">
          Q
        </div>
        <h1 id="loading-title">오늘의 퀴즈를 준비하고 있어요</h1>
        <div className="loading-bar" aria-hidden="true">
          <span />
        </div>
        <p>서버에서 같은 5문제를 안전하게 불러오는 중이에요.</p>
      </section>
    </main>
  );
}

function ErrorPanel({
  error,
  onRetry,
  busy,
}: {
  error: DisplayError;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <main className="app-shell">
      <section className="card error-card" role="alert">
        <span className="status-icon status-icon-error" aria-hidden="true">
          !
        </span>
        <h1>{error.title}</h1>
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
}: {
  daily: DailyStartResponse;
  onStart: () => void;
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
        <h1 id="home-title">오늘 5문제, 얼마나 맞힐까요?</h1>
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
}: {
  daily: DailyStartResponse;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onSubmit: () => void;
  onComplete: () => void;
  busy: boolean;
  actionError: DisplayError | null;
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
          <h1>5문제를 모두 저장했어요</h1>
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
        <h1 id="question-title" tabIndex={-1}>
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
}: {
  daily: DailyStartResponse;
  result: CompleteAttemptResponse;
  onRestart: () => void;
}) {
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
        <h1 id="result-title">오늘 퀴즈 완료!</h1>
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
              </li>
            );
          })}
        </ol>
      </section>

      <section className="next-step-card">
        <strong>친구 대결은 다음 개발 단계에서 연결돼요.</strong>
        <span>지금은 오늘 점수와 서버 저장·복구 흐름까지 완성됐습니다.</span>
        <button className="secondary-button" onClick={onRestart}>
          저장된 결과 다시 불러오기
        </button>
      </section>
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [daily, setDaily] = useState<DailyStartResponse | null>(null);
  const [result, setResult] = useState<CompleteAttemptResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [fatalError, setFatalError] = useState<DisplayError | null>(null);
  const [actionError, setActionError] = useState<DisplayError | null>(null);
  const initialized = useRef(false);
  const pendingAnswer = useRef<PendingAnswer | null>(null);
  const pendingCompleteKey = useRef<string | null>(null);

  const initialize = useCallback(async () => {
    setBusy(true);
    setScreen("loading");
    setFatalError(null);
    setActionError(null);

    try {
      const loadedDaily = await startDailyQuiz();
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
        );
        setResult(loadedResult);
        setScreen("result");
      } else {
        setResult(null);
        setScreen("home");
      }
    } catch (error) {
      setFatalError(toDisplayError(error));
      setScreen("error");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialized.current) {
      return;
    }
    initialized.current = true;
    void initialize();
  }, [initialize]);

  const currentQuestion = useMemo(
    () => daily?.questions[daily.attempt.answeredCount],
    [daily],
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
      setScreen("result");
    } catch (error) {
      setActionError(toDisplayError(error));
      setScreen("quiz");
    } finally {
      setBusy(false);
    }
  }, [daily]);

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
      const displayError = toDisplayError(error);
      setActionError(displayError);
      if (
        error instanceof ApiClientError &&
        ["ANSWER_ALREADY_SUBMITTED", "ANSWER_OUT_OF_ORDER"].includes(error.code)
      ) {
        pendingAnswer.current = null;
      }
    } finally {
      setBusy(false);
    }
  }, [currentQuestion, daily, handleComplete, selectedIndex]);

  if (screen === "loading") {
    return <LoadingScreen />;
  }
  if (screen === "error" || daily === null) {
    return (
      <ErrorPanel
        error={
          fatalError ?? {
            title: "퀴즈를 불러오지 못했어요",
            message: "잠시 후 다시 시도해 주세요.",
          }
        }
        onRetry={() => void initialize()}
        busy={busy}
      />
    );
  }
  if (screen === "home") {
    return <HomeScreen daily={daily} onStart={() => setScreen("quiz")} />;
  }
  if (screen === "result" && result !== null) {
    return (
      <ResultScreen
        daily={daily}
        result={result}
        onRestart={() => void initialize()}
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
    />
  );
}

export default App;
