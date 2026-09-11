import { createChallengeTokenService } from "../challenge/token.js";
import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "../db/client.js";
import {
  runNotificationWorker,
  type NotificationWorkerCounts,
} from "./outbox.js";
import { createNotificationSender } from "./sender.js";
import { createNotificationTargetCrypto } from "./target-crypto.js";

let database: Database | undefined;
let counts: NotificationWorkerCounts | undefined;
let failed = false;
let disabled = false;

try {
  const config = loadConfig();
  if (config.notificationDeliveryEnabled === false) {
    disabled = true;
  } else {
    database = createDatabase(config);
    const targetCrypto = createNotificationTargetCrypto({
      key: config.notificationTargetEncryptionKey,
      version: config.notificationTargetEncryptionKeyVersion,
      previous:
        config.notificationTargetEncryptionKeyPrevious !== undefined &&
        config.notificationTargetEncryptionKeyVersionPrevious !== undefined
          ? {
              key: config.notificationTargetEncryptionKeyPrevious,
              version: config.notificationTargetEncryptionKeyVersionPrevious,
            }
          : undefined,
    });
    const challengeTokens = createChallengeTokenService({
      secret: config.challengeTokenSecret,
      previousSecret: config.challengeTokenSecretPrevious,
    });
    const notificationSender = createNotificationSender(
      config,
      targetCrypto,
      challengeTokens,
    );
    counts = await runNotificationWorker(database, notificationSender);
  }
} catch {
  failed = true;
} finally {
  if (database !== undefined) {
    try {
      await database.close();
    } catch {
      failed = true;
    }
  }
}

if (disabled && !failed) {
  process.stdout.write(
    '{"task":"notification_worker","status":"disabled_by_flag"}\n',
  );
} else if (failed || counts === undefined) {
  process.stderr.write('{"error":"notification_worker_failed"}\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}
