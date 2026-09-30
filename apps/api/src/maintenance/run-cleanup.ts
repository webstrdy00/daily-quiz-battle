import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "../db/client.js";
import { runCleanup, type CleanupCounts } from "./cleanup.js";

let database: Database | undefined;
let counts: CleanupCounts | undefined;
let failed = false;

try {
  const config = loadConfig();
  database = createDatabase(config);
  counts = await runCleanup(database, new Date(), {
    operationalRetentionEnabled: config.operationalRetentionEnabled,
  });
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

if (failed || counts === undefined) {
  process.stderr.write('{"error":"cleanup_failed"}\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}
