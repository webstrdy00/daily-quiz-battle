import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  DeleteAccountResponseSchema,
  ResultNotificationPreferenceResponseSchema,
  type ResultNotificationPreferenceResponse,
} from "@daily-quiz-battle/contracts";
import { decodeJwt } from "jose";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/client.js";
import { createNotificationTargetCrypto } from "../notification/target-crypto.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

interface JsonResponse {
  statusCode: number;
  json(): unknown;
}

interface TestUser {
  anonymousKey: string;
  token: string;
  userId: string;
}

interface PreferenceRow {
  result_enabled: boolean;
  encrypted_anon_key: Buffer | null;
  iv: Buffer | null;
  auth_tag: Buffer | null;
  key_version: number | null;
  agreed_at: Date | string | null;
  revoked_at: Date | string | null;
  updated_at: Date | string;
}

const DEFAULT_AT = new Date("2026-08-29T04:00:00.000Z");
const ENABLED_AT = new Date("2026-08-29T05:00:00.000Z");
const REVOKED_AT = new Date("2026-08-29T06:00:00.000Z");
const CONCURRENT_AT = new Date("2026-08-29T07:00:00.000Z");
const DELETED_AT = new Date("2026-08-29T08:00:00.000Z");

let harness: IntegrationHarness;

before(async () => {
  harness = await createIntegrationHarness();
});

after(async () => {
  await harness?.close();
});

function authorizationHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function getTokenUserId(token: string): string {
  const userId = decodeJwt(token).sub;
  assert.ok(userId, "issued access token must contain a subject");
  return userId;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return new Date(value).toISOString();
}

function expectApiError(
  response: JsonResponse,
  statusCode: number,
  code: string,
): void {
  assert.equal(response.statusCode, statusCode);
  const error = ApiErrorSchema.parse(response.json());
  assert.equal(error.code, code);
}

function parseMinimalPreferenceResponse(
  response: JsonResponse,
): ResultNotificationPreferenceResponse {
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(
    typeof body === "object" && body !== null && !Array.isArray(body),
    "preference response must be a JSON object",
  );
  assert.deepEqual(Object.keys(body).sort(), [
    "deliveryAvailable",
    "enabled",
    "updatedAt",
  ]);
  return ResultNotificationPreferenceResponseSchema.parse(body);
}

async function bootstrapUser(identity: string): Promise<TestUser> {
  const anonymousKey = `dev-notification-preference-it-${identity}`;
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: { anonymousKey },
  });
  assert.equal(response.statusCode, 200);
  const token = BootstrapResponseSchema.parse(response.json()).accessToken;
  return { anonymousKey, token, userId: getTokenUserId(token) };
}

async function getPreference(user: TestUser): Promise<JsonResponse> {
  return harness.app.inject({
    method: "GET",
    url: "/v1/notifications/result-preference",
    headers: authorizationHeaders(user.token),
  });
}

async function putPreference(
  user: TestUser,
  anonymousKey: string,
  enabled: boolean,
): Promise<JsonResponse> {
  return harness.app.inject({
    method: "PUT",
    url: "/v1/notifications/result-preference",
    headers: authorizationHeaders(user.token),
    payload: { anonymousKey, enabled },
  });
}

async function getPreferenceRows(userId: string): Promise<PreferenceRow[]> {
  return harness.database.client<PreferenceRow[]>`
    SELECT
      result_enabled,
      encrypted_anon_key,
      iv,
      auth_tag,
      key_version,
      agreed_at,
      revoked_at,
      updated_at
    FROM notification_preferences
    WHERE user_id = ${userId}
  `;
}

function requireEncryptedTarget(row: PreferenceRow): {
  encryptedAnonymousKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
} {
  assert.ok(
    Buffer.isBuffer(row.encrypted_anon_key),
    "enabled preference must contain ciphertext",
  );
  assert.ok(Buffer.isBuffer(row.iv), "enabled preference must contain an IV");
  assert.ok(
    Buffer.isBuffer(row.auth_tag),
    "enabled preference must contain an authentication tag",
  );
  assert.ok(
    typeof row.key_version === "number",
    "enabled preference must contain a key version",
  );
  return {
    encryptedAnonymousKey: row.encrypted_anon_key,
    iv: row.iv,
    authTag: row.auth_tag,
    keyVersion: row.key_version,
  };
}

test("result preference GET requires authentication and defaults to disabled", async () => {
  harness.setNow(DEFAULT_AT);

  const unauthorized = await harness.app.inject({
    method: "GET",
    url: "/v1/notifications/result-preference",
  });
  expectApiError(unauthorized, 401, "UNAUTHORIZED");

  const user = await bootstrapUser("default");
  const preference = parseMinimalPreferenceResponse(await getPreference(user));
  assert.equal(preference.enabled, false);
  assert.equal(preference.deliveryAvailable, true);
  assert.equal(preference.updatedAt, DEFAULT_AT.toISOString());
  assert.equal((await getPreferenceRows(user.userId)).length, 0);
});

test("result preference PUT rejects malformed and mismatched identities", async () => {
  const owner = await bootstrapUser("identity-owner");
  const other = await bootstrapUser("identity-other");

  const malformed = await harness.app.inject({
    method: "PUT",
    url: "/v1/notifications/result-preference",
    headers: authorizationHeaders(owner.token),
    payload: { enabled: "true" },
  });
  expectApiError(malformed, 400, "INVALID_REQUEST");

  const mismatched = await putPreference(owner, other.anonymousKey, true);
  expectApiError(mismatched, 403, "IDENTITY_MISMATCH");
  assert.equal((await getPreferenceRows(owner.userId)).length, 0);
});

test("preference changes without pending outbox rows encrypt and fully revoke", async () => {
  const user = await bootstrapUser("encryption-lifecycle");
  harness.setNow(ENABLED_AT);

  const pendingRows = await harness.database.client<{ id: string }[]>`
    SELECT id
    FROM notification_outbox
    WHERE recipient_user_id = ${user.userId}
      AND status = 'pending'
  `;
  assert.equal(pendingRows.length, 0);

  const enabled = parseMinimalPreferenceResponse(
    await putPreference(user, user.anonymousKey, true),
  );
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.deliveryAvailable, true);
  assert.equal(enabled.updatedAt, ENABLED_AT.toISOString());

  const enabledRows = await getPreferenceRows(user.userId);
  assert.equal(enabledRows.length, 1);
  const enabledRow = enabledRows[0]!;
  assert.equal(enabledRow.result_enabled, true);
  const encryptedTarget = requireEncryptedTarget(enabledRow);
  assert.equal(encryptedTarget.iv.byteLength, 12);
  assert.equal(encryptedTarget.authTag.byteLength, 16);
  assert.equal(
    encryptedTarget.keyVersion,
    harness.config.notificationTargetEncryptionKeyVersion,
  );
  assert.equal(toIsoDateTime(enabledRow.agreed_at), ENABLED_AT.toISOString());
  assert.equal(enabledRow.revoked_at, null);
  assert.equal(toIsoDateTime(enabledRow.updated_at), ENABLED_AT.toISOString());

  const rawKeyBytes = Buffer.from(user.anonymousKey, "utf8");
  assert.equal(
    encryptedTarget.encryptedAnonymousKey.includes(rawKeyBytes),
    false,
    "ciphertext must not contain the plaintext notification target",
  );
  assert.equal(
    encryptedTarget.encryptedAnonymousKey.byteLength,
    rawKeyBytes.byteLength,
  );

  const targetCrypto = createNotificationTargetCrypto({
    key: harness.config.notificationTargetEncryptionKey,
    version: harness.config.notificationTargetEncryptionKeyVersion,
  });
  const decrypted = targetCrypto.decrypt(user.userId, encryptedTarget);
  assert.equal(
    digest(decrypted),
    digest(user.anonymousKey),
    "stored target must decrypt to the authenticated identity",
  );

  const fetched = parseMinimalPreferenceResponse(await getPreference(user));
  assert.equal(fetched.enabled, true);
  assert.equal(fetched.updatedAt, ENABLED_AT.toISOString());

  harness.setNow(REVOKED_AT);
  const disabled = parseMinimalPreferenceResponse(
    await putPreference(user, user.anonymousKey, false),
  );
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.updatedAt, REVOKED_AT.toISOString());

  const revokedRows = await getPreferenceRows(user.userId);
  assert.equal(revokedRows.length, 1);
  const revokedRow = revokedRows[0]!;
  assert.equal(revokedRow.result_enabled, false);
  assert.equal(revokedRow.encrypted_anon_key, null);
  assert.equal(revokedRow.iv, null);
  assert.equal(revokedRow.auth_tag, null);
  assert.equal(revokedRow.key_version, null);
  assert.equal(revokedRow.agreed_at, null);
  assert.equal(toIsoDateTime(revokedRow.revoked_at), REVOKED_AT.toISOString());
  assert.equal(toIsoDateTime(revokedRow.updated_at), REVOKED_AT.toISOString());

  const fetchedAfterRevocation = parseMinimalPreferenceResponse(
    await getPreference(user),
  );
  assert.equal(fetchedAfterRevocation.enabled, false);
  assert.equal(fetchedAfterRevocation.updatedAt, REVOKED_AT.toISOString());
});

test("delivery off preserves consent, rejects enables, and still fully revokes", async () => {
  const existingUser = await bootstrapUser("delivery-off-existing");
  const newUser = await bootstrapUser("delivery-off-new");
  harness.setNow(ENABLED_AT);
  parseMinimalPreferenceResponse(
    await putPreference(existingUser, existingUser.anonymousKey, true),
  );
  const existingRows = await getPreferenceRows(existingUser.userId);
  requireEncryptedTarget(existingRows[0]!);

  const config = { ...harness.config, notificationDeliveryEnabled: false };
  const database = createDatabase(config);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp({
      config,
      database,
      clock: () => new Date(REVOKED_AT),
    });

    const existing = parseMinimalPreferenceResponse(
      await app.inject({
        method: "GET",
        url: "/v1/notifications/result-preference",
        headers: authorizationHeaders(existingUser.token),
      }),
    );
    assert.equal(existing.enabled, true);
    assert.equal(existing.deliveryAvailable, false);
    assert.equal(existing.updatedAt, ENABLED_AT.toISOString());

    const fresh = parseMinimalPreferenceResponse(
      await app.inject({
        method: "GET",
        url: "/v1/notifications/result-preference",
        headers: authorizationHeaders(newUser.token),
      }),
    );
    assert.equal(fresh.enabled, false);
    assert.equal(fresh.deliveryAvailable, false);

    for (const user of [existingUser, newUser]) {
      const rejected: JsonResponse = await app.inject({
        method: "PUT",
        url: "/v1/notifications/result-preference",
        headers: authorizationHeaders(user.token),
        payload: { anonymousKey: user.anonymousKey, enabled: true },
      });
      expectApiError(rejected, 503, "FEATURE_DISABLED");
      assert.equal(ApiErrorSchema.parse(rejected.json()).retryable, true);
    }
    assert.deepEqual(
      await getPreferenceRows(existingUser.userId),
      existingRows,
    );
    assert.equal((await getPreferenceRows(newUser.userId)).length, 0);

    for (const method of ["GET", "PUT"] as const) {
      const unauthorized = await app.inject({
        method,
        url: "/v1/notifications/result-preference",
        ...(method === "PUT"
          ? {
              payload: {
                anonymousKey: newUser.anonymousKey,
                enabled: true,
              },
            }
          : {}),
      });
      expectApiError(unauthorized, 401, "UNAUTHORIZED");
    }

    const malformed = await app.inject({
      method: "PUT",
      url: "/v1/notifications/result-preference",
      headers: authorizationHeaders(newUser.token),
      payload: { anonymousKey: newUser.anonymousKey, enabled: "true" },
    });
    expectApiError(malformed, 400, "INVALID_REQUEST");
    assert.equal((await getPreferenceRows(newUser.userId)).length, 0);

    const revoked = parseMinimalPreferenceResponse(
      await app.inject({
        method: "PUT",
        url: "/v1/notifications/result-preference",
        headers: authorizationHeaders(existingUser.token),
        payload: {
          anonymousKey: existingUser.anonymousKey,
          enabled: false,
        },
      }),
    );
    assert.equal(revoked.enabled, false);
    assert.equal(revoked.deliveryAvailable, false);
    assert.equal(revoked.updatedAt, REVOKED_AT.toISOString());
    const revokedRows = await getPreferenceRows(existingUser.userId);
    assert.equal(revokedRows.length, 1);
    const row = revokedRows[0]!;
    assert.equal(row.result_enabled, false);
    assert.equal(row.encrypted_anon_key, null);
    assert.equal(row.iv, null);
    assert.equal(row.auth_tag, null);
    assert.equal(row.key_version, null);
    assert.equal(row.agreed_at, null);
    assert.equal(toIsoDateTime(row.revoked_at), REVOKED_AT.toISOString());
    assert.equal(toIsoDateTime(row.updated_at), REVOKED_AT.toISOString());
  } finally {
    if (app !== undefined) {
      await app.close();
    } else {
      await database.close();
    }
  }
});

test("concurrent enables converge on one decryptable preference", async () => {
  const user = await bootstrapUser("concurrent-enable");
  harness.setNow(CONCURRENT_AT);

  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      putPreference(user, user.anonymousKey, true),
    ),
  );
  for (const response of responses) {
    const preference = parseMinimalPreferenceResponse(response);
    assert.equal(preference.enabled, true);
    assert.equal(preference.updatedAt, CONCURRENT_AT.toISOString());
  }

  const rows = await getPreferenceRows(user.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.result_enabled, true);
  const encryptedTarget = requireEncryptedTarget(rows[0]!);
  const targetCrypto = createNotificationTargetCrypto({
    key: harness.config.notificationTargetEncryptionKey,
    version: harness.config.notificationTargetEncryptionKeyVersion,
  });
  assert.equal(
    digest(targetCrypto.decrypt(user.userId, encryptedTarget)),
    digest(user.anonymousKey),
    "concurrent writes must leave a valid encrypted target",
  );
});

test("account deletion removes the notification preference", async () => {
  const user = await bootstrapUser("account-deletion");
  harness.setNow(DELETED_AT);

  const enabled = parseMinimalPreferenceResponse(
    await putPreference(user, user.anonymousKey, true),
  );
  assert.equal(enabled.enabled, true);
  assert.equal((await getPreferenceRows(user.userId)).length, 1);

  const deletion = await harness.app.inject({
    method: "DELETE",
    url: "/v1/me",
    headers: authorizationHeaders(user.token),
    payload: { confirmation: "DELETE" },
  });
  assert.equal(deletion.statusCode, 200);
  DeleteAccountResponseSchema.parse(deletion.json());
  assert.equal((await getPreferenceRows(user.userId)).length, 0);
});
