import assert from "node:assert/strict";
import test from "node:test";
import {
  checkBackup,
  evaluateStatus,
  main,
  parseArgs,
  parseWebhookUrl,
  validMaxAge,
} from "./check-backup.mjs";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const WEBHOOK = "https://discord.com/api/webhooks/123456789/test-only-token";
const receipt = (ageMs = 0, success = true) =>
  JSON.stringify({
    success,
    checkedAt: new Date(NOW - ageMs).toISOString(),
    backup: "private-backup-path",
    error: "postgresql://secret:password@host/database",
  });
const options = { statusFile: "private-status-path" };
const dependencies = (text = receipt(), extra = {}) => ({
  now: () => NOW,
  read: async () => text,
  fetch: async () => {
    assert.fail("Unexpected network request");
  },
  ...extra,
});

test("freshness includes the exact threshold, rejects stale and future receipts", () => {
  const age = 26 * 3_600_000;
  for (const [offset, expected] of [
    [0, "healthy"],
    [age, "healthy"],
    [age + 1, "stale"],
    [-1, "future"],
  ]) {
    assert.equal(evaluateStatus(receipt(offset), { now: NOW }), expected);
  }
  assert.equal(
    evaluateStatus(receipt(3_600_001), { now: NOW, maxAgeHours: 1 }),
    "stale",
  );
  assert.equal(evaluateStatus(receipt(0, false), { now: NOW }), "failed");
  assert.equal(evaluateStatus(receipt(age + 1, false), { now: NOW }), "failed");
});

test("accepts the runner's BOM, fractional seconds and explicit offset", () => {
  const status =
    '\uFEFF{"success":true,"checkedAt":"2026-09-13T21:00:00.0000000+09:00","retentionDays":30}';
  assert.equal(evaluateStatus(status, { now: NOW }), "healthy");
});

test("malformed receipts cannot become successful backups", () => {
  for (const text of [
    "",
    "not-json",
    "null",
    "[]",
    "{}",
    "true",
    '{"success":"true"}',
    JSON.stringify({ success: true, checkedAt: NOW }),
    ...[
      "2026-02-30T12:00:00Z",
      "2026-09-13",
      "2026-09-13T12:00:00",
      "2026-09-13T24:00:00Z",
      "2026-09-13T12:00:60Z",
      "2026-09-13T12:00:00+25:00",
      "secret",
    ].map((checkedAt) => JSON.stringify({ success: true, checkedAt })),
  ]) {
    assert.equal(evaluateStatus(text, { now: NOW }), "malformed");
  }
});

test("finite bounded thresholds and strict CLI arguments", () => {
  assert.deepEqual(parseArgs(["--status-file", "receipt.json"]), {
    statusFile: "receipt.json",
    maxAgeHours: 26,
  });
  assert.deepEqual(
    parseArgs([
      "--max-age-hours",
      "1.5",
      "--status-file",
      "receipt.json",
      "--webhook-url-file",
      "url.txt",
    ]),
    {
      statusFile: "receipt.json",
      maxAgeHours: 1.5,
      webhookUrlFile: "url.txt",
    },
  );
  for (const hours of [
    0,
    -1,
    NaN,
    Infinity,
    -Infinity,
    721,
    Number.MIN_VALUE,
    "26",
  ]) {
    assert.equal(validMaxAge(hours), false);
    assert.equal(
      evaluateStatus(receipt(), { now: NOW, maxAgeHours: hours }),
      "invalid_configuration",
    );
  }
  assert.equal(validMaxAge(720), true);
  assert.equal(
    evaluateStatus(receipt(), { now: NaN }),
    "invalid_configuration",
  );
  for (const args of [
    [],
    ["--status-file"],
    ["--unknown", "value"],
    ["--status-file", " "],
    ["--status-file", "a", "--status-file", "b"],
    ...["0", "-1", "NaN", "Infinity", "721", "0x10", "1e2", " "].map(
      (value) => ["--status-file", "a", "--max-age-hours", value],
    ),
  ])
    assert.throws(() => parseArgs(args));
});

test("missing, unreadable and malformed statuses are sanitized without network", async () => {
  for (const [code, expected] of [
    ["ENOENT", "missing"],
    ["EACCES", "unreadable"],
  ]) {
    const result = await checkBackup(
      options,
      dependencies("", {
        read: async () => {
          throw Object.assign(new Error("private credentials and path"), {
            code,
          });
        },
      }),
    );
    assert.deepEqual(result, {
      exitCode: 1,
      summary: { status: expected, alert: "not_configured" },
    });
  }
  assert.deepEqual(
    await checkBackup(options, dependencies("malformed secret")),
    {
      exitCode: 1,
      summary: { status: "malformed", alert: "not_configured" },
    },
  );
  assert.deepEqual(await checkBackup(options, dependencies()), {
    exitCode: 0,
    summary: { status: "healthy", alert: "not_configured" },
  });
});

test("Discord webhook configuration rejects foreign hosts and unexpected URL components", () => {
  assert.equal(parseWebhookUrl(`\uFEFF${WEBHOOK}\n`), `${WEBHOOK}?wait=true`);
  assert.equal(
    parseWebhookUrl(WEBHOOK.replace("/api/", "/api/v10/")),
    `${WEBHOOK.replace("/api/", "/api/v10/")}?wait=true`,
  );
  for (const url of [
    "",
    "garbage",
    "http://receiver.example",
    "https://user:pass@receiver.example",
    "https://receiver.example/#private",
    "https://recei\nver.example",
    "file:///private",
    WEBHOOK.replace("discord.com", "discord.com.evil.example"),
    WEBHOOK.replace("discord.com", "discord.com:8443"),
    WEBHOOK.replace("/webhooks/", "/channels/"),
    WEBHOOK.replace("123456789", "not-an-id"),
    WEBHOOK.replace("test-only-token", ""),
    `${WEBHOOK}?thread_id=123`,
    `${WEBHOOK}#private`,
  ]) {
    assert.throws(() => parseWebhookUrl(url));
  }
});

test("explicit configured incident sends only allowlisted summary with timeout and no redirects", async () => {
  let calls = 0;
  let cancelled = false;
  const result = await checkBackup(
    { ...options, webhookUrlFile: "private-url-path" },
    dependencies(receipt(), {
      read: async (path) =>
        path === options.statusFile ? receipt(0, false) : WEBHOOK,
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, `${WEBHOOK}?wait=true`);
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(init.headers["Content-Type"], "application/json");
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        assert.deepEqual(JSON.parse(init.body), {
          content: "[Daily Quiz Battle] 백업 상태 경고: failed",
          allowed_mentions: { parse: [] },
        });
        return {
          ok: true,
          body: {
            cancel: async () => {
              cancelled = true;
            },
          },
        };
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.deepEqual(result, {
    exitCode: 1,
    summary: { status: "failed", alert: "delivered" },
  });
});

test("HTTP failure, network failure, timeout and rejected redirects do not claim delivery", async () => {
  for (const send of [
    async () => ({ ok: false }),
    async () => {
      throw new Error("network failure with private endpoint");
    },
    async () => {
      throw new DOMException("private timeout endpoint", "TimeoutError");
    },
    async () => {
      throw new TypeError("redirect contains secret");
    },
  ]) {
    const result = await checkBackup(
      { ...options, webhookUrlFile: "url" },
      dependencies("", {
        read: async (path) =>
          path === options.statusFile ? receipt(27 * 3_600_000) : WEBHOOK,
        fetch: send,
      }),
    );
    assert.deepEqual(result, {
      exitCode: 1,
      summary: { status: "stale", alert: "failed" },
    });
  }
});

test("healthy backups do not send incidents, but invalid requested configuration fails", async () => {
  const configured = { ...options, webhookUrlFile: "url" };
  assert.deepEqual(
    await checkBackup(
      configured,
      dependencies("", {
        read: async (path) =>
          path === options.statusFile ? receipt() : WEBHOOK,
      }),
    ),
    { exitCode: 0, summary: { status: "healthy", alert: "not_needed" } },
  );
  for (const readUrl of [
    async () => "http://receiver.example",
    async () => {
      throw new Error("private path");
    },
  ]) {
    assert.deepEqual(
      await checkBackup(
        configured,
        dependencies("", {
          read: async (path) =>
            path === options.statusFile ? receipt() : readUrl(),
        }),
      ),
      { exitCode: 1, summary: { status: "healthy", alert: "failed" } },
    );
  }
});

test("invalid configuration is sanitized and does not read files or send requests", async () => {
  const deps = dependencies("", {
    read: async () => {
      assert.fail("Unexpected file read");
    },
  });
  assert.deepEqual(await main(["--secret", "private"], deps), {
    exitCode: 1,
    summary: { status: "invalid_configuration", alert: "not_attempted" },
  });
  assert.deepEqual(
    await checkBackup({ ...options, maxAgeHours: Infinity }, deps),
    {
      exitCode: 1,
      summary: { status: "invalid_configuration", alert: "not_attempted" },
    },
  );
});
