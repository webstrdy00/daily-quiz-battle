import assert from "node:assert/strict";
import { test } from "node:test";
import { browserFixture, jsonResponse } from "./helpers/browser-fixture.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const attemptId = "20000000-0000-4000-8000-000000000001";
const daily = {
  status: "available" as const,
  attempt: {
    id: attemptId,
    status: "started" as const,
    quizDate: "2026-10-01",
    answeredCount: 0,
    score: null,
    answers: [],
  },
  questions: Array.from({ length: 5 }, (_, i) => ({
    sequence: i + 1,
    revisionId: `30000000-0000-4000-8000-00000000000${i + 1}`,
    prompt: `문제 ${i + 1}`,
    choices: ["A", "B", "C", "D"] as [string, string, string, string],
  })),
};
const failure = (status: number) =>
  jsonResponse(
    {
      code: status === 401 ? "UNAUTHORIZED" : "RATE_LIMITED",
      message: "테스트 거절",
      requestId: "test",
      retryable: false,
    },
    status,
  );

for (const scenario of [
  "success",
  "repeated401",
  "rateLimited",
  "differentUser",
  "refreshFailure",
] as const) {
  test(
    `deletion refresh is bounded and identity safe: ${scenario}`,
    { timeout: 20000 },
    async (t) => {
      let bootstraps = 0;
      const deletionTokens: string[] = [];
      const browser = await browserFixture(t, {
        fetch({ url, init }) {
          if (url.pathname === "/v1/auth/bootstrap") {
            bootstraps++;
            assert.ok(bootstraps <= 2, "at most one authentication refresh");
            if (scenario === "refreshFailure" && bootstraps === 2)
              return failure(503);
            return jsonResponse({
              accessToken: bootstraps === 1 ? "expired" : "fresh",
              expiresInSeconds: 1800,
              user: {
                id:
                  scenario === "differentUser" && bootstraps === 2
                    ? otherUserId
                    : userId,
                nickname: "검증자",
              },
            });
          }
          if (url.pathname === "/v1/operational-capabilities")
            return jsonResponse({
              analyticsPublishEnabled: false,
              challengeCreateEnabled: true,
              challengeClaimEnabled: true,
            });
          if (url.pathname === "/v1/daily/start") return jsonResponse(daily);
          if (url.pathname === "/v1/me") {
            deletionTokens.push(
              new Headers(init.headers).get("authorization")!,
            );
            assert.ok(deletionTokens.length <= 2, "at most one deletion retry");
            if (deletionTokens.length === 1 || scenario === "repeated401")
              return failure(401);
            if (scenario === "rateLimited") return failure(429);
            return jsonResponse({
              status: "deleted",
              deletedAt: "2026-10-01T00:00:00Z",
            });
          }
          throw new Error(`Unexpected fixture request: ${url.pathname}`);
        },
      });
      await browser.waitFor(
        () => browser.findButton("오늘 퀴즈 시작") !== null,
        "authenticated home",
      );
      const base = browser.app.drafts.newDraft(userId, daily);
      const saved = await browser.app.drafts.mutateDraft(
        base,
        () => ({
          ...base,
          currentQuestion: 5,
          selections: [0, 1, 2, 3, 0],
          frozen: {
            key: "complete-40000000-0000-4000-8000-000000000001",
            answers: base.revisions.map((questionRevisionId, i) => ({
              sequence: i + 1,
              questionRevisionId,
              selectedIndex: i % 4,
            })),
          },
        }),
        () => true,
      );
      const before = browser.storage.getItem(
        browser.app.drafts.draftKey(saved),
      );
      await browser.run(async () => {
        if (scenario === "success") {
          const result = await browser.app.api.deleteAccount({
            confirmation: "DELETE",
          });
          assert.equal(result.status, "deleted");
          assert.equal(browser.app.drafts.readDraft(saved), null);
          await assert.rejects(
            browser.app.drafts.mutateDraft(
              saved,
              () => saved,
              () => true,
            ),
          );
        } else {
          await assert.rejects(
            browser.app.api.deleteAccount({ confirmation: "DELETE" }),
            (error: { code?: string; status?: number }) => {
              if (scenario === "differentUser")
                return error.code === "ACCOUNT_DELETION_IDENTITY_CHANGED";
              return (
                error.status ===
                (scenario === "repeated401"
                  ? 401
                  : scenario === "rateLimited"
                    ? 429
                    : 503)
              );
            },
          );
          assert.equal(
            browser.storage.getItem(browser.app.drafts.draftKey(saved)),
            before,
          );
          if (scenario === "differentUser") {
            await assert.rejects(browser.app.api.bootstrapSession(), {
              code: "SESSION_INVALIDATED",
            });
            assert.equal(browser.app.api.getAuthenticatedUserId(), null);
          } else {
            assert.equal(browser.app.api.getAuthenticatedUserId(), userId);
            assert.deepEqual(
              await browser.app.drafts.mutateDraft(
                saved,
                () => {
                  throw new Error("Frozen data must not be overwritten");
                },
                () => true,
              ),
              saved,
            );
          }
        }
      });
      assert.equal(bootstraps, 2);
      assert.deepEqual(
        deletionTokens,
        scenario === "differentUser" || scenario === "refreshFailure"
          ? ["Bearer expired"]
          : ["Bearer expired", "Bearer fresh"],
      );
      assert.deepEqual(browser.fetchErrors, []);
    },
  );
}
