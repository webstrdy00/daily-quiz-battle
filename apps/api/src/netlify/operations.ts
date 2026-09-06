import type { Config, Context } from "@netlify/functions";
import { loadConfig } from "../config.js";
import { runOperations } from "../operations/runner.js";

export const config: Config = { schedule: "@daily" };

export default async function operations(
  _request: Request,
  _context: Context,
): Promise<Response> {
  try {
    const runtimeConfig = loadConfig();
    if (
      runtimeConfig.appEnvironment === "development" ||
      !runtimeConfig.operationsSchedulerEnabled
    ) {
      throw new Error("operations_failed");
    }

    const databaseUrl = process.env.OPERATIONS_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("operations_failed");
    }
    const url = new URL(databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length <= 1 ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      url.searchParams.get("sslmode") !== "verify-full"
    ) {
      throw new Error("operations_failed");
    }

    // Advisory locks require an operator-selected direct/session endpoint,
    // never the API's transaction-pooling URL.
    const succeeded = await runOperations(
      { ...runtimeConfig, databaseUrl },
      "once",
    );
    if (!succeeded) {
      throw new Error("operations_failed");
    }
    return new Response(null, { status: 204 });
  } catch {
    throw new Error("operations_failed");
  }
}
