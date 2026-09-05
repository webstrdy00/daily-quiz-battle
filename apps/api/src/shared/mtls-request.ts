import { readFileSync } from "node:fs";
import type { OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

export interface MtlsRequestOptions {
  endpoint: URL;
  certificate: string;
  privateKey: string;
  certificateAuthority?: string;
  method: "GET" | "POST";
  headers?: OutgoingHttpHeaders;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface MtlsResponse {
  statusCode: number;
  body: string;
}

export function readPem(value: string): string {
  if (value.includes("-----BEGIN")) {
    return value.replaceAll("\\n", "\n");
  }
  return readFileSync(resolve(value), "utf8");
}

export async function mtlsRequest(
  options: MtlsRequestOptions,
): Promise<MtlsResponse> {
  if (options.endpoint.protocol !== "https:") {
    throw new Error("mTLS endpoint must use HTTPS");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return new Promise<MtlsResponse>((resolveResponse, reject) => {
    const request = httpsRequest(
      options.endpoint,
      {
        method: options.method,
        cert: options.certificate,
        key: options.privateKey,
        ca: options.certificateAuthority,
        rejectUnauthorized: true,
        headers: options.headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        let exceededLimit = false;

        response.on("data", (chunk: Buffer) => {
          responseBytes += chunk.byteLength;
          if (responseBytes > maxResponseBytes) {
            exceededLimit = true;
            reject(new Error("mTLS response is too large"));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (exceededLimit) {
            return;
          }
          resolveResponse({
            statusCode: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("mTLS request timed out"));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}
