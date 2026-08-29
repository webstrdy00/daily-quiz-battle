import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";

const config = loadConfig();
const database = createDatabase(config);
const app = await buildApp({ config, database });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({ host: config.apiHost, port: config.apiPort });
} catch (error) {
  app.log.fatal({ err: error }, "API failed to start");
  await app.close();
  process.exitCode = 1;
}
