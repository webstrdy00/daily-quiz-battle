import { ChallengeTokenSchema, UuidSchema } from "@daily-quiz-battle/contracts";

export type ChallengeLinkTarget = {
  mode: "production" | "private-test";
  path: string;
};

export function createChallengeLinkTarget(
  token: string,
  privateTestDeploymentId?: string,
): ChallengeLinkTarget {
  if (!ChallengeTokenSchema.safeParse(token).success) {
    throw new Error("대결 초대 토큰이 올바르지 않습니다.");
  }

  const path = `daily-quiz-battle-anlee/challenge/${token}`;
  if (privateTestDeploymentId === undefined || privateTestDeploymentId === "") {
    return { mode: "production", path: `intoss://${path}` };
  }
  if (!UuidSchema.safeParse(privateTestDeploymentId).success) {
    throw new Error("비공개 테스트 배포 ID가 올바르지 않습니다.");
  }

  // Preserve the app authority and host from this app's console QR scheme.
  // The target must already be uploaded; it is not this build's future ID.
  return {
    mode: "private-test",
    path: `intoss-private://${path}?_deploymentId=${privateTestDeploymentId}&host=appsInTossHost`,
  };
}
