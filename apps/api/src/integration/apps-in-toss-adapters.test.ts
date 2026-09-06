import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretIdentityVerificationResponse } from "../auth/identity-verifier.js";
import { assertSecureExternalUrls, type AppEnvironment } from "../config.js";
import {
  classifyNotificationRequestFailure,
  interpretNotificationResponse,
} from "../notification/sender.js";
import { AppError } from "../shared/errors.js";

interface ExpectedAppError {
  code: string;
  retryable: boolean;
  statusCode: number;
}

function expectAppError(
  action: () => unknown,
  expected: ExpectedAppError,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AppError);
  assert.equal(thrown.code, expected.code);
  assert.equal(thrown.retryable, expected.retryable);
  assert.equal(thrown.statusCode, expected.statusCode);
  assert.equal(thrown.details, undefined);
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

const identityDependencyFailure: ExpectedAppError = {
  code: "IDENTITY_DEPENDENCY_UNAVAILABLE",
  retryable: true,
  statusCode: 503,
};

const identityInvalidResponse: ExpectedAppError = {
  code: "IDENTITY_INVALID_RESPONSE",
  retryable: true,
  statusCode: 503,
};

const notificationUnavailable: ExpectedAppError = {
  code: "NOTIFICATION_DELIVERY_UNAVAILABLE",
  retryable: true,
  statusCode: 503,
};

const notificationRejected: ExpectedAppError = {
  code: "NOTIFICATION_DELIVERY_REJECTED",
  retryable: false,
  statusCode: 502,
};

const notificationInvalidConfiguration: ExpectedAppError = {
  code: "NOTIFICATION_CONFIGURATION_INVALID",
  retryable: false,
  statusCode: 500,
};

const notificationInvalidTarget: ExpectedAppError = {
  code: "NOTIFICATION_TARGET_INVALID",
  retryable: false,
  statusCode: 500,
};

test("identity interpreter accepts only SUCCESS with a boolean", () => {
  assert.equal(
    interpretIdentityVerificationResponse({
      statusCode: 200,
      body: jsonBody({ resultType: "SUCCESS", success: true }),
    }),
    true,
  );
  assert.equal(
    interpretIdentityVerificationResponse({
      statusCode: 200,
      body: jsonBody({ resultType: "SUCCESS", success: false }),
    }),
    false,
  );

  for (const success of [null, {}, "true", 1]) {
    expectAppError(
      () =>
        interpretIdentityVerificationResponse({
          statusCode: 200,
          body: jsonBody({ resultType: "SUCCESS", success }),
        }),
      identityInvalidResponse,
    );
  }
});

test("identity interpreter reads FAIL error.errorCode and only 200/4010 is false", () => {
  assert.equal(
    interpretIdentityVerificationResponse({
      statusCode: 200,
      body: jsonBody({
        resultType: "FAIL",
        success: null,
        error: { errorCode: "4010", reason: "not exposed" },
      }),
    }),
    false,
  );

  expectAppError(
    () =>
      interpretIdentityVerificationResponse({
        statusCode: 200,
        body: jsonBody({
          resultType: "FAIL",
          error: { code: "4010", reason: "legacy field" },
        }),
      }),
    identityInvalidResponse,
  );
  expectAppError(
    () =>
      interpretIdentityVerificationResponse({
        statusCode: 400,
        body: jsonBody({
          resultType: "FAIL",
          error: { errorCode: "4010", reason: "not exposed" },
        }),
      }),
    identityDependencyFailure,
  );
});

test("identity interpreter makes rate limits and every other non-success retryable", () => {
  for (const [resultType, errorCode] of [
    ["FAIL", "4095"],
    ["FAIL", "9999"],
    ["INTERNAL_ERROR", "9999"],
    ["UNRECOGNIZED_FAILURE", "9999"],
  ] as const) {
    expectAppError(
      () =>
        interpretIdentityVerificationResponse({
          statusCode: 200,
          body: jsonBody({
            resultType,
            success: null,
            error: { errorCode, reason: "not exposed" },
          }),
        }),
      identityDependencyFailure,
    );
  }
});

test("identity interpreter bounds and rejects malformed success responses", () => {
  const oversizedSuccess = jsonBody({
    resultType: "SUCCESS",
    success: true,
    padding: "x".repeat(65_537),
  });
  for (const body of ["not-json", "{}", oversizedSuccess]) {
    expectAppError(
      () => interpretIdentityVerificationResponse({ statusCode: 200, body }),
      identityInvalidResponse,
    );
  }
});

test("identity interpreter treats HTTP 400, 429, and 500 as retryable dependency failures", () => {
  const body = jsonBody({ resultType: "SUCCESS", success: true });
  for (const statusCode of [400, 429, 500]) {
    expectAppError(
      () => interpretIdentityVerificationResponse({ statusCode, body }),
      identityDependencyFailure,
    );
  }
});

test("notification interpreter requires a 2xx SUCCESS envelope with an object", () => {
  for (const statusCode of [200, 201]) {
    assert.doesNotThrow(() =>
      interpretNotificationResponse({
        statusCode,
        body: jsonBody({
          resultType: "SUCCESS",
          success: { msgCount: 1 },
        }),
      }),
    );
  }

  for (const success of [null, true, "sent", [], 1]) {
    expectAppError(
      () =>
        interpretNotificationResponse({
          statusCode: 200,
          body: jsonBody({ resultType: "SUCCESS", success }),
        }),
      notificationRejected,
    );
  }
});

test("notification interpreter classifies documented HTTP 200 business failures", () => {
  const failBody = (errorCode: string): string =>
    jsonBody({
      resultType: "FAIL",
      success: null,
      error: { errorCode, reason: "must not be exposed" },
    });

  expectAppError(
    () =>
      interpretNotificationResponse({
        statusCode: 200,
        body: failBody("4095"),
      }),
    notificationUnavailable,
  );

  for (const errorCode of ["5004", "4034"]) {
    expectAppError(
      () =>
        interpretNotificationResponse({
          statusCode: 200,
          body: failBody(errorCode),
        }),
      notificationInvalidConfiguration,
    );
  }

  expectAppError(
    () =>
      interpretNotificationResponse({
        statusCode: 200,
        body: failBody("4010"),
      }),
    notificationInvalidTarget,
  );
});

test("notification interpreter rejects unknown business and resultType failures", () => {
  for (const body of [
    jsonBody({
      resultType: "FAIL",
      error: { errorCode: "9999", reason: "must not be exposed" },
    }),
    jsonBody({
      resultType: "INTERNAL_ERROR",
      error: { errorCode: "4095", reason: "must not be exposed" },
    }),
    jsonBody({
      resultType: "UNRECOGNIZED_FAILURE",
      error: { errorCode: "9999", reason: "must not be exposed" },
    }),
    jsonBody({
      resultType: "FAIL",
      error: { code: "4095", reason: "legacy field" },
    }),
  ]) {
    expectAppError(
      () => interpretNotificationResponse({ statusCode: 200, body }),
      notificationRejected,
    );
  }
});

test("notification interpreter rejects malformed, non-JSON, and oversized 2xx bodies", () => {
  const oversizedSuccess = jsonBody({
    resultType: "SUCCESS",
    success: { padding: "x".repeat(65_537) },
  });
  for (const body of ["not-json", "{}", oversizedSuccess]) {
    expectAppError(
      () => interpretNotificationResponse({ statusCode: 200, body }),
      notificationRejected,
    );
  }
});

test("notification interpreter classifies HTTP 400, 429, and 500 before envelopes", () => {
  const successBody = jsonBody({ resultType: "SUCCESS", success: {} });
  expectAppError(
    () => interpretNotificationResponse({ statusCode: 400, body: successBody }),
    notificationRejected,
  );
  for (const statusCode of [429, 500]) {
    expectAppError(
      () => interpretNotificationResponse({ statusCode, body: successBody }),
      notificationUnavailable,
    );
  }
});

test("notification transport failures keep network and TLS errors retryable", () => {
  for (const error of [
    new Error("mTLS request timed out"),
    Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }),
    Object.assign(new Error("TLS handshake failed"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    }),
  ]) {
    const classified = classifyNotificationRequestFailure(error);
    assert.equal(classified.code, notificationUnavailable.code);
    assert.equal(classified.retryable, notificationUnavailable.retryable);
    assert.equal(classified.statusCode, notificationUnavailable.statusCode);
    assert.equal(classified.details, undefined);
  }

  const oversized = classifyNotificationRequestFailure(
    new Error("mTLS response is too large"),
  );
  assert.equal(oversized.code, notificationRejected.code);
  assert.equal(oversized.retryable, notificationRejected.retryable);
  assert.equal(oversized.statusCode, notificationRejected.statusCode);
  assert.equal(oversized.details, undefined);

  const invalidCertificate = classifyNotificationRequestFailure(
    Object.assign(new Error("certificate parse failed"), {
      code: "ERR_OSSL_PEM_NO_START_LINE",
    }),
  );
  assert.equal(invalidCertificate.code, notificationInvalidConfiguration.code);
  assert.equal(
    invalidCertificate.retryable,
    notificationInvalidConfiguration.retryable,
  );
  assert.equal(
    invalidCertificate.statusCode,
    notificationInvalidConfiguration.statusCode,
  );
  assert.equal(invalidCertificate.details, undefined);
});

function secureUrlOptions(appEnvironment: AppEnvironment) {
  return {
    appEnvironment,
    identityVerifyUrl: "https://identity.example.com/verify",
    notificationSendUrl: "https://notification.example.com/send",
    allowedOrigins: ["https://app.example.com"],
  };
}

test("staging and production require HTTPS for both adapters and every origin", () => {
  for (const appEnvironment of ["staging", "production"] as const) {
    const secure = secureUrlOptions(appEnvironment);
    assert.doesNotThrow(() => assertSecureExternalUrls(secure));

    for (const insecure of [
      { ...secure, identityVerifyUrl: "http://localhost:3001/verify" },
      { ...secure, notificationSendUrl: "http://localhost:3002/send" },
      {
        ...secure,
        allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
      },
    ]) {
      assert.throws(() => assertSecureExternalUrls(insecure), /must use HTTPS/);
    }
  }
});

test("development permits HTTP loopback but rejects remote HTTP", () => {
  for (const loopbackHost of [
    "localhost",
    "127.0.0.1",
    "127.20.30.40",
    "[::1]",
  ]) {
    assert.doesNotThrow(() =>
      assertSecureExternalUrls({
        appEnvironment: "development",
        identityVerifyUrl: `http://${loopbackHost}:3001/verify`,
        notificationSendUrl: `http://${loopbackHost}:3002/send`,
        allowedOrigins: [`http://${loopbackHost}:5173`],
      }),
    );
  }

  const secure = secureUrlOptions("development");
  for (const insecure of [
    { ...secure, identityVerifyUrl: "http://identity.example.com/verify" },
    {
      ...secure,
      notificationSendUrl: "http://notification.example.com/send",
    },
    { ...secure, allowedOrigins: ["http://app.example.com"] },
  ]) {
    assert.throws(() => assertSecureExternalUrls(insecure), /HTTP loopback/);
  }
});
