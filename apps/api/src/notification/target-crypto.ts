import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../shared/errors.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

export interface EncryptedNotificationTarget {
  encryptedAnonymousKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface NotificationTargetCrypto {
  encrypt(userId: string, anonymousKey: string): EncryptedNotificationTarget;
  decrypt(userId: string, target: EncryptedNotificationTarget): string;
}

function aad(userId: string, version: number): Buffer {
  return Buffer.from(`notification-target:${userId}:v${version}`, "utf8");
}

function decryptionFailed(): AppError {
  return new AppError({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "요청을 처리하지 못했습니다.",
  });
}

export function createNotificationTargetCrypto(options: {
  key: Buffer;
  version: number;
  previous?: {
    key: Buffer;
    version: number;
  };
}): NotificationTargetCrypto {
  if (!Buffer.isBuffer(options.key) || options.key.byteLength !== 32) {
    throw new Error("Notification target encryption key must be 32 bytes");
  }
  if (!Number.isSafeInteger(options.version) || options.version <= 0) {
    throw new Error(
      "Notification target encryption key version must be positive",
    );
  }
  if (
    options.previous !== undefined &&
    (!Buffer.isBuffer(options.previous.key) ||
      options.previous.key.byteLength !== 32)
  ) {
    throw new Error(
      "Previous notification target encryption key must be 32 bytes",
    );
  }
  if (
    options.previous !== undefined &&
    (!Number.isSafeInteger(options.previous.version) ||
      options.previous.version <= 0)
  ) {
    throw new Error(
      "Previous notification target encryption key version must be positive",
    );
  }
  if (
    options.previous !== undefined &&
    options.previous.version === options.version
  ) {
    throw new Error(
      "Previous notification target encryption key version must differ from the current version",
    );
  }

  const key = Buffer.from(options.key);
  const version = options.version;
  const previous =
    options.previous === undefined
      ? undefined
      : {
          key: Buffer.from(options.previous.key),
          version: options.previous.version,
        };

  return {
    encrypt(userId, anonymousKey) {
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(aad(userId, version));
      const encryptedAnonymousKey = Buffer.concat([
        cipher.update(anonymousKey, "utf8"),
        cipher.final(),
      ]);

      return {
        encryptedAnonymousKey,
        iv,
        authTag: cipher.getAuthTag(),
        keyVersion: version,
      };
    },

    decrypt(userId, target) {
      const decryptionKey =
        target.keyVersion === version
          ? key
          : previous?.version === target.keyVersion
            ? previous.key
            : undefined;
      if (decryptionKey === undefined) {
        throw decryptionFailed();
      }

      try {
        const decipher = createDecipheriv(ALGORITHM, decryptionKey, target.iv);
        decipher.setAAD(aad(userId, target.keyVersion));
        decipher.setAuthTag(target.authTag);
        return Buffer.concat([
          decipher.update(target.encryptedAnonymousKey),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw decryptionFailed();
      }
    },
  };
}
