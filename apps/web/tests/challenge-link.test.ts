import assert from "node:assert/strict";
import { test } from "node:test";
import { createChallengeLinkTarget } from "../src/lib/challenge-link.ts";

const token = "Ab0_-".repeat(8) + "xyz";
const deploymentId = "01a0c937-d87d-749e-8126-304bcba0b134";

test("absent private target preserves the production intoss path", () => {
  for (const value of [undefined, ""]) {
    assert.deepEqual(createChallengeLinkTarget(token, value), {
      mode: "production",
      path: `intoss://daily-quiz-battle-anlee/challenge/${token}`,
    });
  }
});

test("private target preserves the actual console authority, deployment and host", () => {
  const target = createChallengeLinkTarget(token, deploymentId);
  assert.equal(target.mode, "private-test");
  assert.equal(
    target.path,
    `intoss-private://daily-quiz-battle-anlee/challenge/${token}?_deploymentId=${deploymentId}&host=appsInTossHost`,
  );
  const url = new URL(target.path);
  assert.equal(url.protocol, "intoss-private:");
  assert.equal(url.hostname, "daily-quiz-battle-anlee");
  assert.equal(url.pathname, `/challenge/${token}`);
  assert.deepEqual(
    [...url.searchParams],
    [
      ["_deploymentId", deploymentId],
      ["host", "appsInTossHost"],
    ],
  );
  assert.equal(url.hash, "");
});

test("invalid private deployment never silently falls back to production", () => {
  for (const value of [
    " ",
    "latest",
    "undefined",
    deploymentId.slice(1),
    `${deploymentId} `,
    `${deploymentId}&host=other`,
    `${deploymentId}#fragment`,
    `intoss-private://daily-quiz-battle-anlee?_deploymentId=${deploymentId}`,
  ]) {
    assert.throws(
      () => createChallengeLinkTarget(token, value),
      /비공개 테스트 배포 ID/,
    );
  }
});

test("invalid tokens fail closed for both production and private targets", () => {
  for (const value of [
    "",
    token.slice(1),
    `${token}a`,
    `${token.slice(1)}/`,
    `${token.slice(1)}?`,
    `${token.slice(1)}#`,
    `${token.slice(1)}%`,
    `${token.slice(1)}=`,
    `${token.slice(1)} `,
    `${token.slice(1)}한`,
  ]) {
    for (const target of [undefined, deploymentId]) {
      assert.throws(
        () => createChallengeLinkTarget(value, target),
        /대결 초대 토큰/,
      );
    }
  }
});
