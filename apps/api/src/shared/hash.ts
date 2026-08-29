import { createHash, createHmac } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintAnonymousKey(
  anonymousKey: string,
  pepper: string,
): string {
  return createHmac("sha256", pepper)
    .update(anonymousKey, "utf8")
    .digest("hex");
}
