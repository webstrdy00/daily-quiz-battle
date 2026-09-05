import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "../shared/hash.js";

/**
 * ADR-0003: the share token is never stored. It is derived from the
 * challenge id with a server secret and only its SHA-256 hash is persisted
 * as the lookup key. Replay of `POST /v1/challenges` re-derives the token.
 */
export interface ChallengeTokenService {
  derive(challengeId: string): string;
  hash(token: string): string;
  /** Re-derive for replay; falls back to the previous secret during rotation. */
  deriveMatching(challengeId: string, expectedHash: string): string | null;
}

function deriveWith(secret: string, challengeId: string): string {
  return createHmac("sha256", secret)
    .update(challengeId, "utf8")
    .digest("base64url");
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createChallengeTokenService(options: {
  secret: string;
  previousSecret?: string;
}): ChallengeTokenService {
  const secrets = [options.secret, options.previousSecret].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );

  return {
    derive(challengeId) {
      return deriveWith(options.secret, challengeId);
    },
    hash(token) {
      return sha256(token);
    },
    deriveMatching(challengeId, expectedHash) {
      for (const secret of secrets) {
        const candidate = deriveWith(secret, challengeId);
        if (hashesEqual(sha256(candidate), expectedHash)) {
          return candidate;
        }
      }
      return null;
    },
  };
}
