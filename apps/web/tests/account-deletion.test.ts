import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  CompleteAttemptResponse,
  DailyStartResponse,
} from "@daily-quiz-battle/contracts";
import type { QuizDraft } from "../src/lib/quiz-draft.ts";
import {
  browserFixture,
  deferred,
  jsonResponse,
  type BrowserFixture,
  type FetchCall,
} from "./helpers/browser-fixture.ts";

type AvailableDaily = Extract<DailyStartResponse, { status: "available" }>;
const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const attemptId = "20000000-0000-4000-8000-000000000001";
const frozenAttemptId = "20000000-0000-4000-8000-000000000002";
const completionKey = "complete-40000000-0000-4000-8000-000000000001";
const selections = [0, 1, 2, 3, 0];
const deleted = { status: "deleted", deletedAt: "2026-10-01T00:03:00Z" };
const testOptions = { timeout: 20_000, concurrency: false };

function daily(id = attemptId): AvailableDaily {
  return {
    status: "available",
    attempt: {
      id,
      status: "started",
      quizDate: "2026-10-01",
      answeredCount: 0,
      score: null,
      answers: [],
    },
    questions: Array.from({ length: 5 }, (_, index) => ({
      sequence: index + 1,
      revisionId: `30000000-0000-4000-8000-00000000000${index + 1}`,
      prompt: `삭제 회귀 문제 ${index + 1}`,
      choices: ["첫 번째 답", "두 번째 답", "세 번째 답", "네 번째 답"],
    })),
  };
}

function rejected(status: number, code: string): Response {
  return jsonResponse(
    {
      code,
      message: `계정 삭제 거절 ${status}`,
      requestId: `test-delete-${status}`,
      retryable: status === 429 || status >= 500,
    },
    status,
  );
}

function completed(draft: QuizDraft): CompleteAttemptResponse {
  assert.ok(draft.frozen);
  return {
    status: "completed",
    attemptId: draft.attemptId,
    score: 5,
    total: 5,
    completedAt: "2026-10-01T00:02:00Z",
    review: daily(draft.attemptId).questions.map((question, index) => ({
      sequence: question.sequence,
      prompt: question.prompt,
      selectedIndex: draft.selections[index]!,
      correctIndex: draft.selections[index]!,
      correct: true,
      explanation: `해설 ${question.sequence}`,
    })),
  };
}

function requestCount(browser: BrowserFixture, method: string, path: string) {
  return browser.calls.filter(
    ({ url, init }) =>
      (init.method ?? "GET") === method && url.pathname === path,
  ).length;
}

async function deletionFixture(
  t: TestContext,
  options: {
    delete: (call: FetchCall, count: number) => Response | Promise<Response>;
    firstDaily?: Promise<Response>;
    complete?: (call: FetchCall, count: number) => Response | Promise<Response>;
    expectedFetchErrors?: unknown[];
  },
) {
  let bootstrapCount = 0;
  let dailyCount = 0;
  let deletionCount = 0;
  let completionCount = 0;
  const browser = await browserFixture(t, {
    fetch(call) {
      const { url, init } = call;
      const method = init.method ?? "GET";
      switch (`${method} ${url.pathname}`) {
        case "POST /v1/auth/bootstrap":
          bootstrapCount++;
          assert.equal(
            bootstrapCount,
            1,
            "only the initial bootstrap may create a user",
          );
          assert.deepEqual(JSON.parse(String(init.body)), {
            anonymousKey: "dev-react-integration",
          });
          return jsonResponse({
            accessToken: "test-original-token",
            expiresInSeconds: 3600,
            user: { id: userId, nickname: "참여자" },
          });
        case "GET /v1/operational-capabilities":
          return jsonResponse({
            analyticsPublishEnabled: false,
            challengeCreateEnabled: true,
            challengeClaimEnabled: true,
          });
        case "POST /v1/daily/start":
          dailyCount++;
          return dailyCount === 1 && options.firstDaily
            ? options.firstDaily
            : jsonResponse(daily());
        case "GET /v1/notifications/result-preference":
          return jsonResponse({
            enabled: false,
            deliveryAvailable: false,
            updatedAt: "2026-10-01T00:00:00Z",
          });
        case "DELETE /v1/me":
          assert.deepEqual(JSON.parse(String(init.body)), {
            confirmation: "DELETE",
          });
          return options.delete(call, ++deletionCount);
        case `POST /v1/attempts/${frozenAttemptId}/complete`:
          assert.ok(
            options.complete,
            "completion must have an explicit fixture",
          );
          return options.complete(call, ++completionCount);
        default:
          throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }
    },
  });
  t.after(() => {
    assert.deepEqual(
      browser.fetchErrors,
      options.expectedFetchErrors ?? [],
      "all requests use deterministic expected fixtures",
    );
  });
  await browser.waitFor(
    () => requestCount(browser, "POST", "/v1/daily/start") === 1,
    "the initial authenticated daily request",
  );
  return browser;
}

async function savedDrafts(browser: BrowserFixture) {
  const { drafts, api } = browser.app;
  const isCurrent = () => api.getAuthenticatedUserId() === userId;
  const base = drafts.newDraft(userId, daily());
  const selected = await drafts.mutateDraft(
    base,
    (stored) => ({
      ...(stored ?? base),
      selections: [2, null, null, null, null],
    }),
    isCurrent,
  );
  const frozenBase = drafts.newDraft(userId, daily(frozenAttemptId));
  const frozen = await drafts.mutateDraft(
    frozenBase,
    () => ({
      ...frozenBase,
      selections: [...selections],
      currentQuestion: 5,
      frozen: {
        key: completionKey,
        answers: frozenBase.revisions.map((questionRevisionId, index) => ({
          sequence: index + 1,
          questionRevisionId,
          selectedIndex: selections[index],
        })),
      },
    }),
    isCurrent,
  );
  const snapshots = [selected, frozen].map((draft) => ({
    draft,
    serialized: browser.storage.getItem(drafts.draftKey(draft)),
  }));
  for (const snapshot of snapshots) assert.ok(snapshot.serialized);
  const generation = drafts.getDraftGeneration(userId);
  return {
    selected,
    frozen,
    assertPreserved() {
      assert.equal(drafts.getDraftGeneration(userId), generation);
      for (const { draft, serialized } of snapshots) {
        assert.equal(
          browser.storage.getItem(drafts.draftKey(draft)),
          serialized,
        );
        assert.deepEqual(drafts.readDraft(draft), draft);
      }
    },
  };
}

const definitiveRejections = [
  { status: 403, code: "FORBIDDEN" },
  { status: 429, code: "RATE_LIMITED" },
];

for (const rejection of definitiveRejections) {
  test(
    `DELETE ${rejection.status} preserves selected answers and the exact frozen completion retry`,
    testOptions,
    async (t) => {
      let frozen: QuizDraft | undefined;
      const completionRequests: { key: string | null; body: unknown }[] = [];
      const browser = await deletionFixture(t, {
        delete(call, count) {
          assert.equal(count, 1);
          assert.equal(
            new Headers(call.init.headers).get("authorization"),
            "Bearer test-original-token",
          );
          return rejected(rejection.status, rejection.code);
        },
        complete(call, count) {
          assert.ok(frozen?.frozen);
          completionRequests.push({
            key: new Headers(call.init.headers).get("idempotency-key"),
            body: JSON.parse(String(call.init.body)),
          });
          return count === 1
            ? rejected(503, "SERVICE_UNAVAILABLE")
            : jsonResponse(completed(frozen));
        },
      });
      const saved = await savedDrafts(browser);
      frozen = saved.frozen;
      const submission = frozen.frozen!;
      await assert.rejects(
        browser.app.api.completeAttempt(
          frozen.attemptId,
          { answers: submission.answers },
          submission.key,
        ),
        { code: "SERVICE_UNAVAILABLE", status: 503 },
      );
      await browser.run(async () => {
        await assert.rejects(
          browser.app.api.deleteAccount({ confirmation: "DELETE" }),
          { code: rejection.code, status: rejection.status },
        );
      });

      saved.assertPreserved();
      assert.equal(browser.app.api.getAuthenticatedUserId(), userId);
      const resumed = await browser.app.api.startDailyQuiz();
      assert.equal(resumed.status, "available");
      if (resumed.status !== "available")
        assert.fail("the same attempt must resume");
      assert.equal(resumed.attempt.id, saved.selected.attemptId);
      const updated = await browser.app.drafts.mutateDraft(
        saved.selected,
        (stored) => {
          assert.ok(stored);
          return { ...stored, selections: [3, ...stored.selections.slice(1)] };
        },
        () => browser.app.api.getAuthenticatedUserId() === userId,
      );
      assert.equal(
        browser.app.drafts.draftKey(updated),
        browser.app.drafts.draftKey(saved.selected),
      );
      assert.deepEqual(browser.app.drafts.readDraft(updated)?.selections, [
        3,
        null,
        null,
        null,
        null,
      ]);
      let attemptedFrozenChange = false;
      const stillFrozen = await browser.app.drafts.mutateDraft(
        frozen,
        () => {
          attemptedFrozenChange = true;
          return { ...frozen!, frozen: null };
        },
        () => browser.app.api.getAuthenticatedUserId() === userId,
      );
      assert.equal(
        attemptedFrozenChange,
        false,
        "a frozen submission cannot be replaced",
      );
      assert.deepEqual(stillFrozen, frozen);
      for (let retry = 0; retry < 2; retry++) {
        assert.deepEqual(
          await browser.app.api.completeAttempt(
            frozen.attemptId,
            { answers: submission.answers },
            submission.key,
          ),
          completed(frozen),
          "a completed replay returns the same result",
        );
      }
      assert.deepEqual(
        completionRequests,
        Array.from({ length: 3 }, () => ({
          key: completionKey,
          body: { answers: submission.answers },
        })),
      );
      assert.deepEqual(
        browser.app.drafts.readDraft(frozen)?.frozen,
        submission,
      );
      assert.equal(requestCount(browser, "POST", "/v1/auth/bootstrap"), 1);
      assert.equal(requestCount(browser, "DELETE", "/v1/me"), 1);
    },
  );
}

for (const rejection of definitiveRejections) {
  test(
    `settings DELETE ${rejection.status} rejection returns to the quiz with the previous selection still editable`,
    testOptions,
    async (t) => {
      const initialDaily = deferred<Response>();
      t.after(() => initialDaily.resolve(jsonResponse(daily())));
      const browser = await deletionFixture(t, {
        firstDaily: initialDaily.promise,
        delete(_call, count) {
          assert.equal(count, 1);
          return rejected(rejection.status, rejection.code);
        },
      });
      const saved = await savedDrafts(browser);
      await browser.run(() => initialDaily.resolve(jsonResponse(daily())));
      await browser.waitFor(
        () => browser.findButton("오늘 퀴즈 시작")?.disabled === false,
        "the restored quiz home",
      );
      await browser.clickButton("계정 설정");
      await browser.waitFor(
        () =>
          browser.document.querySelector("main")?.getAttribute("aria-busy") ===
          "false",
        "loaded account settings",
      );
      const confirmation = browser.document.querySelector<HTMLInputElement>(
        "#delete-confirmation",
      );
      assert.ok(confirmation);
      await browser.run(() => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        assert.ok(setValue);
        setValue.call(confirmation, "DELETE");
        confirmation.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await browser.clickButton("계정 삭제 계속");
      await browser.clickButton("계정 영구 삭제");
      await browser.waitFor(
        () =>
          browser.document
            .querySelector('[role="alert"]')
            ?.textContent?.includes(`계정 삭제 거절 ${rejection.status}`) ===
            true && browser.findButton("취소하고 돌아가기")?.disabled === false,
        "the definitive deletion rejection",
      );
      saved.assertPreserved();
      await browser.clickButton("취소하고 돌아가기");
      await browser.clickButton("오늘 퀴즈 시작");
      await browser.waitFor(
        () =>
          browser.document.querySelector("h1")?.textContent ===
          daily().questions[0].prompt,
        "the same restored question",
      );
      const previousChoice = browser.document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="2"]',
      );
      assert.ok(previousChoice);
      assert.equal(
        previousChoice.checked,
        true,
        "the actual quiz retains the selected third answer",
      );
      const nextChoice = browser.document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="1"]',
      );
      assert.ok(nextChoice);
      await browser.click(nextChoice);
      assert.equal(nextChoice.checked, true);
      assert.deepEqual(
        browser.app.drafts.readDraft(saved.selected)?.selections,
        [1, null, null, null, null],
      );
      assert.deepEqual(
        browser.app.drafts.readDraft(saved.frozen),
        saved.frozen,
      );
      assert.equal(
        requestCount(browser, "POST", "/v1/daily/start"),
        1,
        "returning to the quiz does not create or load another attempt",
      );
      assert.equal(requestCount(browser, "POST", "/v1/auth/bootstrap"), 1);
    },
  );
}

const networkFailure = new TypeError("mock deletion connection lost");
const uncertainOutcomes = [
  { name: "HTTP 500", response: () => rejected(500, "INTERNAL_ERROR") },
  { name: "HTTP 503", response: () => rejected(503, "SERVICE_UNAVAILABLE") },
  {
    name: "network rejection",
    response: (): Response => {
      throw networkFailure;
    },
    expectedFetchErrors: [networkFailure],
  },
  {
    name: "invalid HTTP 200 schema",
    response: () => jsonResponse({ status: "deleted" }),
  },
  {
    name: "invalid HTTP 200 JSON",
    response: () => new Response("not-json", { status: 200 }),
  },
];

for (const outcome of uncertainOutcomes) {
  test(
    `DELETE ${outcome.name} preserves drafts and freezes all later requests without a new bootstrap`,
    testOptions,
    async (t) => {
      const browser = await deletionFixture(t, {
        delete(_call, count) {
          assert.equal(count, 1);
          return outcome.response();
        },
        expectedFetchErrors: outcome.expectedFetchErrors,
      });
      const saved = await savedDrafts(browser);
      await browser.run(async () => {
        await assert.rejects(
          browser.app.api.deleteAccount({ confirmation: "DELETE" }),
          { code: "ACCOUNT_DELETION_OUTCOME_UNKNOWN", retryable: false },
        );
      });
      saved.assertPreserved();
      assert.equal(browser.app.api.getAuthenticatedUserId(), null);
      const callCount = browser.calls.length;
      const submission = saved.frozen.frozen!;
      for (const request of [
        () => browser.app.api.startDailyQuiz(),
        () => browser.app.api.getResultNotificationPreference(),
        () => browser.app.api.bootstrapSession(),
        () => browser.app.api.deleteAccount({ confirmation: "DELETE" }),
        () =>
          browser.app.api.completeAttempt(
            saved.frozen.attemptId,
            { answers: submission.answers },
            submission.key,
          ),
      ]) {
        await assert.rejects(request(), { code: "SESSION_INVALIDATED" });
        assert.equal(
          browser.calls.length,
          callCount,
          "a blocked request must not contact the server",
        );
      }
      let lateWrite = false;
      await assert.rejects(
        browser.app.drafts.mutateDraft(
          saved.selected,
          () => {
            lateWrite = true;
            return {
              ...saved.selected,
              selections: [1, null, null, null, null],
            };
          },
          () => browser.app.api.getAuthenticatedUserId() === userId,
        ),
      );
      assert.equal(lateWrite, false);
      saved.assertPreserved();
      assert.equal(requestCount(browser, "POST", "/v1/auth/bootstrap"), 1);
      assert.equal(requestCount(browser, "DELETE", "/v1/me"), 1);
    },
  );
}

test(
  "confirmed deletion clears only that user's drafts and rejects late writes",
  testOptions,
  async (t) => {
    const deletion = deferred<Response>();
    t.after(() => deletion.resolve(jsonResponse(deleted)));
    const browser = await deletionFixture(t, {
      delete(_call, count) {
        assert.equal(count, 1);
        return deletion.promise;
      },
    });
    const saved = await savedDrafts(browser);
    const other = browser.app.drafts.newDraft(otherUserId, daily());
    await browser.app.drafts.mutateDraft(
      other,
      () => other,
      () => true,
    );
    let pending!: ReturnType<typeof browser.app.api.deleteAccount>;
    await browser.run(() => {
      pending = browser.app.api.deleteAccount({ confirmation: "DELETE" });
    });
    assert.equal(requestCount(browser, "DELETE", "/v1/me"), 1);
    saved.assertPreserved();
    assert.equal(
      browser.app.api.getAuthenticatedUserId(),
      null,
      "writes are suspended while deletion is pending",
    );
    await browser.run(() => deletion.resolve(jsonResponse(deleted)));
    assert.deepEqual(await pending, deleted);
    for (const draft of [saved.selected, saved.frozen]) {
      assert.equal(
        browser.storage.getItem(browser.app.drafts.draftKey(draft)),
        null,
      );
      assert.equal(browser.app.drafts.readDraft(draft), null);
      let wrote = false;
      await assert.rejects(
        browser.app.drafts.mutateDraft(
          draft,
          () => {
            wrote = true;
            return draft;
          },
          () => true,
        ),
        /기기의 답안이 삭제됐어요/,
      );
      assert.equal(
        wrote,
        false,
        "even a late writer with a stale current-session predicate cannot resurrect the draft",
      );
    }
    assert.deepEqual(browser.app.drafts.readDraft(other), other);
    const unseen = browser.app.drafts.newDraft(
      userId,
      daily("20000000-0000-4000-8000-000000000003"),
    );
    await assert.rejects(
      browser.app.drafts.mutateDraft(
        unseen,
        () => unseen,
        () => true,
      ),
      /기기의 답안이 삭제됐어요/,
    );
    assert.equal(browser.app.api.getAuthenticatedUserId(), null);
    const callCount = browser.calls.length;
    await assert.rejects(browser.app.api.startDailyQuiz(), {
      code: "SESSION_INVALIDATED",
    });
    await assert.rejects(browser.app.api.bootstrapSession(), {
      code: "SESSION_INVALIDATED",
    });
    assert.equal(browser.calls.length, callCount);
  },
);
