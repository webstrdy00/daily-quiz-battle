import type { Config, Context } from "@netlify/functions";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "../db/client.js";
import {
  handleNetlifyRequest,
  isValidProviderIp,
  unavailableResponse,
} from "../hosting/request-handler.js";

let application: Promise<FastifyInstance> | undefined;

async function initializeApp(): Promise<FastifyInstance> {
  let database: Database | undefined;
  let app: FastifyInstance | undefined;
  try {
    const runtimeConfig = loadConfig();
    if (runtimeConfig.appEnvironment === "development") {
      throw new Error("Development configuration is forbidden in Netlify");
    }
    database = createDatabase(runtimeConfig);
    app = await buildApp({ config: runtimeConfig, database });
    await app.ready();
    return app;
  } catch {
    // buildApp owns cleanup of any instance that fails before it is returned.
    // Do not expose configuration, certificate, Redis, or database error details.
    try {
      if (app !== undefined) {
        await app.close();
      }
    } finally {
      await database?.close().catch(() => undefined);
    }
    throw new Error("API initialization failed");
  }
}

function getApp(): Promise<FastifyInstance> {
  application ??= initializeApp().catch(() => {
    application = undefined;
    throw new Error("API initialization failed");
  });
  return application;
}

export default async function api(
  request: Request,
  context: Context,
): Promise<Response> {
  const startedAt = performance.now();
  if (!isValidProviderIp(context.ip)) {
    return unavailableResponse(request.method);
  }
  let initializationMs = 0;
  let response: Response;
  try {
    const app = await getApp();
    initializationMs = performance.now() - startedAt;
    response = await handleNetlifyRequest(app, request, context);
  } catch {
    response = unavailableResponse(request.method);
  }
  console.info(
    JSON.stringify({
      event: "netlify_request_finished",
      status: response.status,
      initializationMs: Math.round(initializationMs),
      totalMs: Math.round(performance.now() - startedAt),
    }),
  );
  return response;
}

export const config: Config = {
  path: ["/v1/*", "/health/*", "/internal/metrics"],
};
