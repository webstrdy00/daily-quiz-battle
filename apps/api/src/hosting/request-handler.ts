import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { Context } from "@netlify/functions";
import type { FastifyInstance, InjectOptions } from "fastify";

export function isValidProviderIp(value: unknown): value is string {
  return typeof value === "string" && !value.includes("%") && isIP(value) !== 0;
}

export function unavailableResponse(method: string): Response {
  const requestId = randomUUID();
  return new Response(
    method === "HEAD"
      ? null
      : JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "요청을 처리하지 못했습니다.",
          requestId,
          retryable: true,
        }),
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    },
  );
}

/** Only Netlify's trusted context supplies the socket address; proxy headers do not. */
export async function handleNetlifyRequest(
  app: FastifyInstance,
  request: Request,
  context: Partial<Pick<Context, "ip">>,
): Promise<Response> {
  if (!isValidProviderIp(context.ip)) {
    return unavailableResponse(request.method);
  }

  const url = new URL(request.url);
  const payload =
    request.body === null
      ? undefined
      : Readable.fromWeb(request.body as ReadableStream<Uint8Array>);
  try {
    const result = await app.inject({
      method: request.method as InjectOptions["method"],
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      remoteAddress: context.ip,
      // Do not buffer first: Fastify must enforce its existing body limit.
      payload,
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      if (value === undefined) {
        continue;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        headers.append(name, String(item));
      }
    }
    const bodyless =
      request.method === "HEAD" ||
      result.statusCode === 204 ||
      result.statusCode === 205 ||
      result.statusCode === 304;
    return new Response(bodyless ? null : new Uint8Array(result.rawPayload), {
      status: result.statusCode,
      headers,
    });
  } finally {
    payload?.destroy();
  }
}
