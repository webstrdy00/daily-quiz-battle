#!/usr/bin/env node
// node ops/check-backup.mjs --status-file PATH [--max-age-hours 26] [--webhook-url-file PATH]
// The optional URL file contains a Discord webhook; never log its contents.
// Only unhealthy checks send alerts. No URL file means no network and no delivery claim.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MAX_AGE_HOURS = 26;
export const WEBHOOK_TIMEOUT_MS = 10_000;

export function validMaxAge(hours) {
  // A positive interval up to 30 days; reject sub-millisecond and infinite values.
  return Number.isFinite(hours) && hours * 3_600_000 >= 1 && hours <= 720;
}

export function parseArgs(args) {
  const options = { maxAgeHours: DEFAULT_MAX_AGE_HOURS };
  const names = new Map([
    ["--status-file", "statusFile"],
    ["--max-age-hours", "maxAgeHours"],
    ["--webhook-url-file", "webhookUrlFile"],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !names.has(flag) ||
      seen.has(flag) ||
      !value?.trim() ||
      value.startsWith("--")
    ) {
      throw new Error("Invalid arguments.");
    }
    seen.add(flag);
    if (flag === "--max-age-hours" && !/^\d+(?:\.\d+)?$/.test(value)) {
      throw new Error("Invalid arguments.");
    }
    options[names.get(flag)] =
      flag === "--max-age-hours" ? Number(value) : value;
  }
  if (!options.statusFile || !validMaxAge(options.maxAgeHours)) {
    throw new Error("Invalid arguments.");
  }
  return options;
}

function parseTimestamp(value) {
  if (typeof value !== "string") return NaN;
  // PowerShell emits seven fractional digits and an explicit UTC offset.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    return NaN;
  return Date.parse(value);
}

export function evaluateStatus(
  text,
  { now = Date.now(), maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {},
) {
  if (!Number.isFinite(now) || !validMaxAge(maxAgeHours))
    return "invalid_configuration";
  let status;
  try {
    // Windows PowerShell Set-Content -Encoding UTF8 writes a BOM.
    status = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return "malformed";
  }
  if (!status || Array.isArray(status) || typeof status.success !== "boolean")
    return "malformed";
  const checkedAt = parseTimestamp(status.checkedAt);
  if (!Number.isFinite(checkedAt)) return "malformed";
  if (checkedAt > now) return "future";
  if (!status.success) return "failed";
  return now - checkedAt > maxAgeHours * 3_600_000 ? "stale" : "healthy";
}

export function parseWebhookUrl(text) {
  const value = text.trim();
  if (/[\x00-\x20\x7f]/.test(value))
    throw new Error("Invalid webhook configuration.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "discord.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)
  ) {
    throw new Error("Invalid webhook configuration.");
  }
  url.searchParams.set("wait", "true");
  return url.href;
}

export async function checkBackup(
  options,
  { read = readFile, now = Date.now, fetch: send = globalThis.fetch } = {},
) {
  let status;
  const clock = now();
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  if (
    !options.statusFile ||
    !validMaxAge(maxAgeHours) ||
    !Number.isFinite(clock)
  ) {
    return {
      exitCode: 1,
      summary: { status: "invalid_configuration", alert: "not_attempted" },
    };
  }
  try {
    status = evaluateStatus(await read(options.statusFile, "utf8"), {
      now: clock,
      maxAgeHours,
    });
  } catch (error) {
    status = error?.code === "ENOENT" ? "missing" : "unreadable";
  }
  let alert = "not_configured";
  if (options.webhookUrlFile !== undefined) {
    try {
      const url = parseWebhookUrl(await read(options.webhookUrlFile, "utf8"));
      alert = "not_needed";
      if (status !== "healthy") {
        const response = await send(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `[Daily Quiz Battle] 백업 상태 경고: ${status}`,
            allowed_mentions: { parse: [] },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        // Never read or emit a receiver's potentially sensitive response body.
        await response.body?.cancel();
        alert = response.ok ? "delivered" : "failed";
      }
    } catch {
      alert = "failed";
    }
  }
  return {
    exitCode: status === "healthy" && alert !== "failed" ? 0 : 1,
    summary: { status, alert },
  };
}

export async function main(args, dependencies) {
  try {
    return await checkBackup(parseArgs(args), dependencies);
  } catch {
    return {
      exitCode: 1,
      summary: { status: "invalid_configuration", alert: "not_attempted" },
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await main(process.argv.slice(2));
  console.log(JSON.stringify(result.summary));
  process.exitCode = result.exitCode;
}
