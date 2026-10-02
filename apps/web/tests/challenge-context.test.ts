import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  ChallengeResultResponse,
  DailyStartResponse,
} from "@daily-quiz-battle/contracts";
import {
  isChallengeContextCurrent,
  isDraftForQuizDate,
  runChallengeRequest,
  type ChallengeContext,
} from "../src/lib/challenge-context.ts";
import {
  clearQuizDateDrafts,
  mutateDraft,
  newDraft,
  readDraft,
} from "../src/lib/quiz-draft.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const oldDate = "2026-09-30";
const today = "2026-10-01";
const token = "Ab0_-".repeat(8) + "xyz";

function context(): ChallengeContext {
  return {
    generation: 1,
    requestGeneration: 0,
    userId,
    token,
    quizDate: oldDate,
    accountDeleted: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function response(
  status: ChallengeResultResponse["status"],
): ChallengeResultResponse {
  const base = { quizDate: oldDate, viewerRole: "creator" as const };
  switch (status) {
    case "open":
    case "claimed":
      return {
        ...base,
        status,
        expiresAt: "2026-10-02T00:00:00Z",
        me: { nickname: "Me", score: 4 },
        opponent: { nickname: null, completed: false },
      };
    case "completed":
      return {
        ...base,
        status,
        completedAt: "2026-09-30T10:00:00Z",
        outcome: "draw",
        me: { nickname: "Me", score: 4 },
        opponent: { nickname: "Friend", score: 4 },
      };
    case "redacted":
      return { ...base, status, me: { nickname: "Me", score: 4 } };
    case "voided":
      return { ...base, status, voidedAt: "2026-09-30T11:00:00Z" };
  }
}

type Effect =
  | { kind: "result"; value: ChallengeResultResponse }
  | { kind: "error"; value: unknown }
  | { kind: "finally" };

function refreshFixture() {
  const current = context();
  const effects: Effect[] = [];
  const state = { refreshing: false };
  const begin = () => {
    current.requestGeneration += 1;
    const captured = { ...current };
    const pending = deferred<ChallengeResultResponse>();
    state.refreshing = true;
    const settled = runChallengeRequest({
      request: () => pending.promise,
      isCurrent: () => isChallengeContextCurrent(captured, current),
      onResult: (value) => effects.push({ kind: "result", value }),
      onError: (value) => effects.push({ kind: "error", value }),
      onFinally: () => {
        effects.push({ kind: "finally" });
        state.refreshing = false;
      },
    });
    return { ...pending, settled };
  };
  return { current, effects, state, begin };
}

const transitions: {
  name: string;
  change: (current: ChallengeContext) => void;
}[] = [
  {
    name: "navigation to today's quiz",
    change: (current) => {
      current.generation += 1;
      current.token = null;
      current.quizDate = today;
    },
  },
  {
    name: "date switch",
    change: (current) => {
      current.quizDate = today;
    },
  },
  {
    name: "challenge switch",
    change: (current) => {
      current.token = "C".repeat(43);
    },
  },
  {
    name: "account switch",
    change: (current) => {
      current.userId = otherUserId;
    },
  },
  {
    name: "account deletion start",
    change: (current) => {
      current.generation += 1;
    },
  },
  {
    name: "account deletion end",
    change: (current) => {
      current.accountDeleted = true;
    },
  },
  {
    name: "unmount or reinitialization",
    change: (current) => {
      current.generation += 1;
    },
  },
];

const outcomes: (
  | { name: string; result: ChallengeResultResponse }
  | { name: string; error: unknown }
)[] = [
  ...(["open", "claimed", "completed", "redacted", "voided"] as const).map(
    (status) => ({ name: `${status} response`, result: response(status) }),
  ),
  { name: "network error", error: new Error("Network unavailable") },
  { name: "challenge issue", error: { code: "CHALLENGE_NOT_FOUND" } },
  { name: "voided error", error: { code: "DAILY_SET_VOIDED" } },
];

for (const transition of transitions) {
  for (const outcome of outcomes) {
    test(`late ${outcome.name} cannot apply results, errors or finally after ${transition.name}`, async () => {
      const fixture = refreshFixture();
      const request = fixture.begin();
      transition.change(fixture.current);
      if ("error" in outcome) request.reject(outcome.error);
      else request.resolve(outcome.result);
      await request.settled;
      assert.deepEqual(fixture.effects, []);
      assert.equal(
        fixture.state.refreshing,
        true,
        "a stale finally cannot clear another context's request flag",
      );
    });
  }
}

for (const outcome of outcomes) {
  test(`current ${outcome.name} still applies and finishes its request`, async () => {
    const fixture = refreshFixture();
    const request = fixture.begin();
    if ("error" in outcome) request.reject(outcome.error);
    else request.resolve(outcome.result);
    await request.settled;
    assert.deepEqual(fixture.effects, [
      "error" in outcome
        ? { kind: "error", value: outcome.error }
        : { kind: "result", value: outcome.result },
      { kind: "finally" },
    ]);
    assert.equal(fixture.state.refreshing, false);
  });
}

for (const oldRequestFails of [false, true]) {
  for (const oldRequestFinishesFirst of [false, true]) {
    test(`concurrent refresh ignores the old ${oldRequestFails ? "error" : "result"} when it finishes ${oldRequestFinishesFirst ? "first" : "last"}`, async () => {
      const fixture = refreshFixture();
      const older = fixture.begin();
      const newer = fixture.begin();
      const currentResult = response("completed");
      const finishOlder = async () => {
        if (oldRequestFails) older.reject({ code: "DAILY_SET_VOIDED" });
        else older.resolve(response("voided"));
        await older.settled;
      };
      if (oldRequestFinishesFirst) {
        await finishOlder();
        assert.deepEqual(fixture.effects, []);
        assert.equal(fixture.state.refreshing, true);
      }
      newer.resolve(currentResult);
      await newer.settled;
      if (!oldRequestFinishesFirst) await finishOlder();
      assert.deepEqual(fixture.effects, [
        { kind: "result", value: currentResult },
        { kind: "finally" },
      ]);
      assert.equal(fixture.state.refreshing, false);
    });
  }
}

test("returning to the same challenge, date and account does not revive an earlier generation", () => {
  const captured = context();
  const current = { ...captured, generation: captured.generation + 2 };
  assert.equal(isChallengeContextCurrent(captured, current), false);
});

test("a manual refresh supersedes an existing poll but allows the next same-challenge poll", () => {
  const current = context();
  const olderPoll = { ...current };
  current.requestGeneration += 1;
  assert.equal(isChallengeContextCurrent(olderPoll, current), false);
  const nextPoll = { ...current };
  assert.equal(isChallengeContextCurrent(nextPoll, current), true);
  current.quizDate = today;
  assert.equal(isChallengeContextCurrent(nextPoll, current), false);
});

test("finally rechecks context when a valid result itself invalidates the request", async () => {
  const current = context();
  const captured = { ...current };
  const effects: string[] = [];
  await runChallengeRequest({
    request: async () => response("voided"),
    isCurrent: () => isChallengeContextCurrent(captured, current),
    onResult: () => {
      effects.push("voided");
      current.generation += 1;
    },
    onError: () => {
      effects.push("error");
    },
    onFinally: () => {
      effects.push("finally");
    },
  });
  assert.deepEqual(effects, ["voided"]);
});

function environment(t: TestContext) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, String(value));
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
  const originals = ["localStorage", "navigator"].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  t.after(() => {
    for (const { name, descriptor } of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, value: storage },
    navigator: {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, operation: () => unknown) =>
            operation(),
        },
      },
    },
  });
}

function daily(
  attempt = 1,
  quizDate = oldDate,
): Extract<DailyStartResponse, { status: "available" }> {
  return {
    status: "available",
    attempt: {
      id: `20000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`,
      status: "started",
      quizDate,
      answeredCount: 0,
      score: null,
      answers: [],
    },
    questions: Array.from({ length: 5 }, (_, index) => ({
      sequence: index + 1,
      revisionId: `30000000-0000-4000-8000-00000000000${index + 1}`,
      prompt: `Question ${index + 1}`,
      choices: ["A", "B", "C", "D"],
    })),
  };
}

for (const status of ["completed", "voided"] as const) {
  test(`${status} cleanup removes only the result's date and account, preserving today's selections`, async (t) => {
    environment(t);
    const oldDraft = newDraft(userId, daily());
    const sameDateDraft = newDraft(userId, daily(2));
    const todayDraft = {
      ...newDraft(userId, daily(3, today)),
      selections: [2, 1, null, null, null],
      currentQuestion: 1,
    };
    const otherAccountDraft = newDraft(otherUserId, daily());
    for (const draft of [
      oldDraft,
      sameDateDraft,
      todayDraft,
      otherAccountDraft,
    ])
      await mutateDraft(
        draft,
        () => draft,
        () => true,
      );

    const loaded = response(status);
    assert.equal(isDraftForQuizDate(oldDraft, userId, loaded.quizDate), true);
    assert.equal(
      isDraftForQuizDate(sameDateDraft, userId, loaded.quizDate),
      true,
    );
    assert.equal(
      isDraftForQuizDate(todayDraft, userId, loaded.quizDate),
      false,
    );
    assert.equal(
      isDraftForQuizDate(otherAccountDraft, userId, loaded.quizDate),
      false,
    );
    assert.equal(isDraftForQuizDate(null, userId, loaded.quizDate), false);
    assert.equal(isDraftForQuizDate(oldDraft, null, loaded.quizDate), false);
    await clearQuizDateDrafts(userId, loaded.quizDate);
    assert.equal(readDraft(oldDraft), null);
    assert.equal(readDraft(sameDateDraft), null);
    assert.deepEqual(readDraft(todayDraft), todayDraft);
    assert.deepEqual(readDraft(otherAccountDraft), otherAccountDraft);
    await assert.rejects(
      mutateDraft(
        oldDraft,
        () => oldDraft,
        () => true,
      ),
      /기기의 답안이 삭제됐어요/,
      "valid cleanup must still prevent resurrection of the completed or voided draft",
    );
  });
}

for (const outcome of outcomes.filter(
  (outcome) =>
    "error" in outcome ||
    outcome.result.status === "completed" ||
    outcome.result.status === "voided",
)) {
  test(`navigation preserves the new screen and saved draft after a late ${outcome.name}`, async (t) => {
    environment(t);
    const saved = {
      ...newDraft(userId, daily(3, today)),
      selections: [3, 2, 1, null, null],
      currentQuestion: 2,
    };
    await mutateDraft(
      saved,
      () => saved,
      () => true,
    );
    const current = context();
    const captured = { ...current };
    const pending = deferred<ChallengeResultResponse>();
    const view: {
      screen: string;
      draft: typeof saved | null;
      error: unknown;
      refreshing: boolean;
    } = {
      screen: "challenge-waiting",
      draft: null,
      error: null,
      refreshing: true,
    };
    let cleanup = Promise.resolve();
    const settled = runChallengeRequest({
      request: () => pending.promise,
      isCurrent: () => isChallengeContextCurrent(captured, current),
      onResult: (loaded) => {
        view.screen = loaded.status;
        if (isDraftForQuizDate(view.draft, userId, loaded.quizDate))
          view.draft = null;
        cleanup = clearQuizDateDrafts(userId, loaded.quizDate);
      },
      onError: (error) => {
        view.screen = "error";
        view.error = error;
      },
      onFinally: () => {
        view.refreshing = false;
      },
    });
    current.generation += 1;
    current.token = null;
    current.quizDate = today;
    view.screen = "quiz";
    view.draft = saved;
    if ("error" in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.result);
    await settled;
    await cleanup;
    assert.equal(view.screen, "quiz");
    assert.equal(view.draft, saved);
    assert.equal(view.error, null);
    assert.equal(view.refreshing, true);
    assert.deepEqual(readDraft(saved), saved);
  });
}
