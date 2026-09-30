import {
  CompleteAttemptRequestSchema,
  type CompleteAttemptRequest,
  type DailyStartResponse,
} from "@daily-quiz-battle/contracts";

type Daily = Extract<DailyStartResponse, { status: "available" }>;
export interface QuizDraft {
  version: 1;
  userId: string;
  attemptId: string;
  quizDate: string;
  revisions: string[];
  selections: (number | null)[];
  currentQuestion: number;
  frozen: { key: string; answers: CompleteAttemptRequest["answers"] } | null;
}
export const draftPrefix = "daily-quiz:draft:v1:";
const removedPrefix = "daily-quiz:removed:v1:";
export function getDraftGeneration(userId: string): string | null {
  return localStorage.getItem(`${removedPrefix}${userId}`);
}
function userLock(userId: string): string {
  return `${draftPrefix}${userId}`;
}
function withDraftLock<T>(userId: string, operation: () => T): Promise<T> {
  if (!navigator.locks) return Promise.reject(storageError());
  return navigator.locks.request(userLock(userId), operation);
}
function assertNotRemoved(draft: QuizDraft): void {
  if (
    localStorage.getItem(
      `${removedPrefix}${draft.userId}/${draft.quizDate}`,
    ) !== null ||
    localStorage.getItem(`${removedPrefix}${draftKey(draft)}`) !== null
  ) {
    throw new Error(
      "기기의 답안이 삭제됐어요. 서버에서 최신 상태를 다시 확인해 주세요.",
    );
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function storageError(): Error {
  return new Error(
    "기기에 임시 보관하지 못했어요. 브라우저 저장 공간을 허용한 뒤 다시 시도해 주세요. 최종 제출은 임시 보관에 성공해야 가능해요.",
  );
}
export function draftKey(
  draft: Pick<QuizDraft, "userId" | "attemptId" | "quizDate">,
): string {
  return `${draftPrefix}${draft.userId}/${draft.attemptId}/${draft.quizDate}`;
}
export function newDraft(userId: string, daily: Daily): QuizDraft {
  if (
    !uuid.test(userId) ||
    !uuid.test(daily.attempt.id) ||
    daily.questions.length !== 5
  ) {
    throw new Error("임시 답안의 사용자와 문제 정보를 확인하지 못했어요.");
  }
  return {
    version: 1,
    userId,
    attemptId: daily.attempt.id,
    quizDate: daily.attempt.quizDate,
    revisions: daily.questions.map((question) => question.revisionId),
    selections: daily.questions.map(
      (question) =>
        daily.attempt.answers.find(
          (answer) => answer.sequence === question.sequence,
        )?.selectedIndex ?? null,
    ),
    currentQuestion: 0,
    frozen: null,
  };
}
export function readDraft(base: QuizDraft): QuizDraft | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(draftKey(base));
  } catch {
    throw storageError();
  }
  if (raw === null) return null;
  try {
    if (raw.length > 8192) throw new Error();
    const value = JSON.parse(raw) as QuizDraft;
    if (
      value.version !== 1 ||
      value.userId !== base.userId ||
      value.attemptId !== base.attemptId ||
      value.quizDate !== base.quizDate ||
      JSON.stringify(value.revisions) !== JSON.stringify(base.revisions) ||
      !Array.isArray(value.selections) ||
      value.selections.length !== 5 ||
      !value.selections.every(
        (index) =>
          index === null ||
          (Number.isInteger(index) && index >= 0 && index <= 3),
      ) ||
      !Number.isInteger(value.currentQuestion) ||
      value.currentQuestion < 0 ||
      value.currentQuestion > 5
    )
      throw new Error();
    if (value.frozen !== null) {
      if (
        !value.frozen ||
        typeof value.frozen.key !== "string" ||
        !value.frozen.key.startsWith("complete-") ||
        !uuid.test(value.frozen.key.slice(9))
      )
        throw new Error();
      const parsed = CompleteAttemptRequestSchema.parse({
        answers: value.frozen.answers,
      });
      if (
        !parsed.answers.every(
          (answer, index) =>
            answer.sequence === index + 1 &&
            answer.questionRevisionId === base.revisions[index] &&
            answer.selectedIndex === value.selections[index],
        )
      )
        throw new Error();
      value.frozen = { key: value.frozen.key, answers: parsed.answers };
    }
    return {
      ...base,
      selections: value.selections,
      currentQuestion: value.currentQuestion,
      frozen: value.frozen,
    };
  } catch {
    throw new Error(
      "기기의 임시 답안을 확인하지 못했어요. 서버에서 최신 제출 상태를 다시 확인해 주세요.",
    );
  }
}
function saveDraft(draft: QuizDraft): void {
  try {
    const previousRaw = localStorage.getItem(draftKey(draft));
    if (previousRaw !== null) {
      const previous = JSON.parse(previousRaw) as QuizDraft;
      if (
        previous.frozen &&
        JSON.stringify(previous.frozen) !== JSON.stringify(draft.frozen)
      ) {
        throw new Error();
      }
    }
    const serialized = JSON.stringify(draft);
    localStorage.setItem(draftKey(draft), serialized);
    if (localStorage.getItem(draftKey(draft)) !== serialized) throw new Error();
  } catch {
    throw storageError();
  }
}
export function mutateDraft(
  base: QuizDraft,
  change: (stored: QuizDraft | null) => QuizDraft,
  isCurrent: () => boolean,
): Promise<QuizDraft> {
  const generation = getDraftGeneration(base.userId);
  return withDraftLock(base.userId, () => {
    if (!isCurrent() || generation !== getDraftGeneration(base.userId))
      throw new Error("답안 상태가 변경되어 임시 보관을 중단했어요.");
    assertNotRemoved(base);
    const stored = readDraft(base);
    // Every writer rereads under the same lock; a freeze always wins.
    const updated = stored?.frozen ? stored : change(stored);
    saveDraft(updated);
    return updated;
  });
}
export function clearDraft(
  draft: Pick<QuizDraft, "userId" | "attemptId" | "quizDate">,
): Promise<void> {
  return withDraftLock(draft.userId, () => {
    try {
      localStorage.setItem(`${removedPrefix}${draftKey(draft)}`, "1");
      localStorage.removeItem(draftKey(draft));
    } catch {
      throw storageError();
    }
  });
}
export function clearUserDrafts(userId: string): Promise<void> {
  return withDraftLock(userId, () => {
    try {
      localStorage.setItem(`${removedPrefix}${userId}`, crypto.randomUUID());
      const prefix = `${draftPrefix}${userId}/`;
      const keys = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      );
      for (const key of keys)
        if (key?.startsWith(prefix)) {
          localStorage.setItem(`${removedPrefix}${key}`, "1");
          localStorage.removeItem(key);
        }
    } catch {
      throw storageError();
    }
  });
}

export function clearQuizDateDrafts(
  userId: string,
  quizDate: string,
): Promise<void> {
  return withDraftLock(userId, () => {
    try {
      localStorage.setItem(`${removedPrefix}${userId}/${quizDate}`, "1");
      const prefix = `${draftPrefix}${userId}/`;
      const keys = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      );
      for (const key of keys) {
        if (key?.startsWith(prefix) && key.endsWith(`/${quizDate}`))
          localStorage.removeItem(key);
      }
    } catch {
      throw storageError();
    }
  });
}
