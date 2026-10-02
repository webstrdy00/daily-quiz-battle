import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  ChallengeLandingResponse,
  ChallengeResultResponse,
  ClaimChallengeResponse,
  CompleteAttemptResponse,
  DailyStartResponse,
} from "@daily-quiz-battle/contracts";
import {
  browserFixture,
  deferred,
  jsonResponse,
  type BrowserFixture,
} from "./helpers/browser-fixture.ts";

type AvailableDaily = Extract<DailyStartResponse, { status: "available" }>;
const userId = "10000000-0000-4000-8000-000000000001";
const previousAttemptId = "20000000-0000-4000-8000-000000000001";
const todayAttemptId = "20000000-0000-4000-8000-000000000002";
const token = "A".repeat(43);
const challengePath = `/v1/challenges/${token}`;
const expiresAt = "2026-10-03T12:00:00Z";

function daily(
  attemptId: string,
  quizDate: string,
  label: string,
): AvailableDaily {
  return {
    status: "available",
    attempt: {
      id: attemptId,
      status: "started",
      quizDate,
      answeredCount: 0,
      score: null,
      answers: [],
    },
    questions: Array.from(
      { length: 5 },
      (_, index): AvailableDaily["questions"][number] => ({
        sequence: index + 1,
        revisionId: `${attemptId === previousAttemptId ? "30000000" : "40000000"}-0000-4000-8000-00000000000${index + 1}`,
        prompt: `${label} 문제 ${index + 1}`,
        choices: ["첫 번째 답", "두 번째 답", "세 번째 답", "네 번째 답"],
      }),
    ),
  };
}

const previous = daily(previousAttemptId, "2026-09-30", "이전 날짜");
const today = daily(todayAttemptId, "2026-10-01", "오늘 날짜");
const completedAttempt: CompleteAttemptResponse = {
  status: "completed",
  attemptId: previousAttemptId,
  score: 5,
  total: 5,
  completedAt: "2026-10-01T00:01:00Z",
  review: previous.questions.map((question) => ({
    sequence: question.sequence,
    prompt: question.prompt,
    selectedIndex: 0,
    correctIndex: 0,
    correct: true,
    explanation: `이전 날짜 해설 ${question.sequence}`,
  })),
};
const completedChallenge: ChallengeResultResponse = {
  status: "completed",
  quizDate: previous.attempt.quizDate,
  completedAt: "2026-10-01T00:01:00Z",
  viewerRole: "opponent",
  outcome: "win",
  me: { nickname: "참여자", score: 5 },
  opponent: { nickname: "친구", score: 3 },
};
const voidedChallenge: ChallengeResultResponse = {
  status: "voided",
  quizDate: previous.attempt.quizDate,
  voidedAt: "2026-10-01T00:02:00Z",
  viewerRole: "opponent",
};

function unavailable(message: string): Response {
  return jsonResponse(
    {
      code: "SERVICE_UNAVAILABLE",
      message,
      requestId: "test-result-unavailable",
      retryable: true,
    },
    503,
  );
}

function resultRequests(fixture: BrowserFixture): number {
  return fixture.calls.filter(
    ({ url }) => url.pathname === `${challengePath}/result`,
  ).length;
}

async function pendingManualRefresh(t: TestContext) {
  const pending = deferred<Response>();
  let fixture: BrowserFixture | undefined;
  // Release before the browser cleanup even if a UI assertion fails midway.
  t.after(async () => {
    if (fixture) {
      await fixture.run(() => pending.resolve(unavailable("cleanup")));
    } else {
      pending.resolve(unavailable("cleanup"));
    }
  });
  fixture = await browserFixture(t, {
    path: `/challenge/${token}`,
    fetch({ url, init }) {
      const method = init.method ?? "GET";
      switch (`${method} ${url.pathname}`) {
        case "POST /v1/auth/bootstrap":
          assert.deepEqual(JSON.parse(String(init.body)), {
            anonymousKey: "dev-react-integration",
          });
          return jsonResponse({
            accessToken: "test-access-token",
            expiresInSeconds: 3600,
            user: { id: userId, nickname: "참여자" },
          });
        case "GET /v1/operational-capabilities":
          return jsonResponse({
            analyticsPublishEnabled: false,
            challengeCreateEnabled: true,
            challengeClaimEnabled: true,
          });
        case `GET ${challengePath}`: {
          const landing: ChallengeLandingResponse = {
            status: "claimed",
            quizDate: previous.attempt.quizDate,
            expiresAt,
            creatorNickname: "친구",
            viewerRole: "opponent",
          };
          return jsonResponse(landing);
        }
        case `POST ${challengePath}/claim`: {
          const claimed: ClaimChallengeResponse = {
            challenge: {
              status: "claimed",
              quizDate: previous.attempt.quizDate,
              expiresAt,
            },
            daily: previous,
          };
          return jsonResponse(claimed);
        }
        case `POST /v1/attempts/${previousAttemptId}/complete`:
          assert.deepEqual(JSON.parse(String(init.body)), {
            answers: previous.questions.map((question) => ({
              sequence: question.sequence,
              questionRevisionId: question.revisionId,
              selectedIndex: 0,
            })),
          });
          assert.match(
            new Headers(init.headers).get("idempotency-key") ?? "",
            /^complete-[0-9a-f-]{36}$/,
          );
          return jsonResponse(completedAttempt);
        case `GET ${challengePath}/result`:
          if (resultRequests(fixture!) === 1) {
            return unavailable("초기 대결 결과 응답 실패");
          }
          assert.equal(
            resultRequests(fixture!),
            2,
            "only the manual retry is pending",
          );
          return pending.promise;
        case "POST /v1/daily/start":
          return jsonResponse(today);
        default:
          throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }
    },
  });
  const browser = fixture;
  t.after(() => {
    assert.deepEqual(
      browser.fetchErrors,
      [],
      "all requests use expected fixtures",
    );
  });
  assert.equal(browser.document.hidden, true, "automatic polling is paused");

  for (let index = 0; index < previous.questions.length; index++) {
    await browser.waitFor(
      () =>
        browser.document.querySelector("h1")?.textContent ===
        previous.questions[index].prompt,
      `previous-day question ${index + 1}`,
    );
    const choice = browser.document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="0"]',
    );
    assert.ok(choice);
    await browser.click(choice);
    assert.equal(choice.checked, true);
    await browser.clickButton(index === 4 ? "답안 검토" : "다음");
  }
  await browser.waitFor(
    () => browser.findButton("5문제 최종 제출") !== null,
    "batch-completion review",
  );
  await browser.clickButton("5문제 최종 제출");
  await browser.waitFor(
    () => browser.findButton("대결 결과 다시 확인") !== null,
    "retry after the initial result HTTP 503",
  );
  assert.match(
    browser.document.body.textContent ?? "",
    /초기 대결 결과 응답 실패/,
  );
  assert.equal(resultRequests(browser), 1);
  assert.equal(
    browser.storage.getItem(
      browser.app.drafts.draftKey(
        browser.app.drafts.newDraft(userId, previous),
      ),
    ),
    null,
    "successful batch completion removed the previous attempt draft",
  );

  await browser.clickButton("대결 결과 다시 확인");
  await browser.waitFor(
    () =>
      resultRequests(browser) === 2 &&
      browser.findButton("다시 확인하는 중…")?.disabled === true,
    "in-flight manual result refresh",
  );
  assert.equal(browser.findButton("오늘의 퀴즈로 이동")?.disabled, false);
  return { browser, pending };
}

const staleResponses = [
  { name: "completed", response: () => jsonResponse(completedChallenge) },
  {
    name: "HTTP 503 error",
    response: () => unavailable("늦게 도착한 대결 오류"),
  },
  { name: "voided", response: () => jsonResponse(voidedChallenge) },
];

for (const variant of staleResponses) {
  test(
    `late previous-day challenge ${variant.name} preserves today's quiz and saved answer`,
    {
      timeout: 20_000,
      concurrency: false,
    },
    async (t) => {
      const { browser, pending } = await pendingManualRefresh(t);
      await browser.clickButton("오늘의 퀴즈로 이동");
      await browser.waitFor(
        () => browser.findButton("오늘 퀴즈 시작") !== null,
        "today's different date and attempt",
      );
      assert.equal(
        browser.document.querySelector(".date-chip")?.textContent,
        today.attempt.quizDate,
      );
      await browser.clickButton("오늘 퀴즈 시작");
      await browser.waitFor(
        () =>
          browser.document.querySelector("h1")?.textContent ===
          today.questions[0].prompt,
        "today's first question",
      );
      const choice = browser.document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="2"]',
      );
      assert.ok(choice);
      await browser.click(choice);
      assert.equal(choice.checked, true);

      const base = browser.app.drafts.newDraft(userId, today);
      const key = browser.app.drafts.draftKey(base);
      const serializedBefore = browser.storage.getItem(key);
      assert.ok(serializedBefore);
      const draftBefore = browser.app.drafts.readDraft(base);
      assert.ok(draftBefore);
      assert.equal(draftBefore.attemptId, todayAttemptId);
      assert.equal(draftBefore.quizDate, today.attempt.quizDate);
      assert.deepEqual(draftBefore.selections, [2, null, null, null, null]);
      assert.equal(draftBefore.currentQuestion, 0);
      assert.equal(draftBefore.frozen, null);
      const domBefore = browser.document.querySelector("main")!.outerHTML;

      await browser.run(() => pending.resolve(variant.response()));

      assert.equal(
        browser.document.querySelector("h1")?.textContent,
        today.questions[0].prompt,
      );
      assert.deepEqual(
        [
          ...browser.document.querySelectorAll<HTMLInputElement>(
            'input[type="radio"]',
          ),
        ].map((input) => input.checked),
        [false, false, true, false],
        "the current third choice remains selected",
      );
      assert.equal(
        browser.document.querySelector("main")?.outerHTML,
        domBefore,
      );
      assert.equal(
        browser.storage.getItem(key),
        serializedBefore,
        "the current draft is byte-for-byte unchanged",
      );
      assert.deepEqual(browser.app.drafts.readDraft(base), draftBefore);
      assert.equal(resultRequests(browser), 2);
      assert.equal(
        browser.calls.filter(({ url }) => url.pathname === "/v1/daily/start")
          .length,
        1,
      );
    },
  );
}

test(
  "same-context manual challenge result still transitions to the completed result",
  {
    timeout: 20_000,
    concurrency: false,
  },
  async (t) => {
    const { browser, pending } = await pendingManualRefresh(t);
    await browser.run(() => pending.resolve(jsonResponse(completedChallenge)));
    await browser.waitFor(
      () => browser.document.querySelector("h1")?.textContent === "승리했어요!",
      "the valid completed challenge result",
    );
    assert.ok(browser.document.querySelector('[aria-label="최종 대결 점수"]'));
    assert.deepEqual(
      [...browser.document.querySelectorAll(".versus-complete strong")].map(
        (element) => element.textContent,
      ),
      ["5", "3"],
    );
    assert.ok(browser.findButton("개인 오늘 퀴즈로 이동"));
    assert.equal(resultRequests(browser), 2);
    assert.equal(
      browser.calls.filter(({ url }) => url.pathname === "/v1/daily/start")
        .length,
      0,
    );
  },
);
