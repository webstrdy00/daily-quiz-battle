import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  OperationalCapabilitiesResponseSchema,
  type OperationalCapabilitiesResponse,
} from "@daily-quiz-battle/contracts";
import { buildApp } from "../app.js";
import { createDatabase, type Database } from "../db/client.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./test-harness.js";

interface TableNameRow {
  table_name: string;
}

interface SerializedRow {
  row_data: string;
}

interface JsonResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

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

async function bootstrapUser(): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/bootstrap",
    payload: {
      anonymousKey: "dev-operational-capabilities-integration-user",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return BootstrapResponseSchema.parse(response.json()).accessToken;
}

async function snapshotDatabase(
  database: Database,
): Promise<Record<string, string[]>> {
  const tables = await database.client<TableNameRow[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const snapshot: Record<string, string[]> = {};

  for (const { table_name: tableName } of tables) {
    const rows = await database.client<SerializedRow[]>`
      SELECT to_jsonb(snapshot_row)::text AS row_data
      FROM ${database.client(tableName)} AS snapshot_row
      ORDER BY to_jsonb(snapshot_row)::text
    `;
    snapshot[tableName] = rows.map(({ row_data: rowData }) => rowData);
  }

  return snapshot;
}

function assertCapabilitiesResponse(
  response: JsonResponse,
  capabilities: OperationalCapabilitiesResponse,
): void {
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body, capabilities);
  assert.deepEqual(
    OperationalCapabilitiesResponseSchema.parse(body),
    capabilities,
  );
}

test("operational capabilities require authentication and expose configured flags without database mutation", async () => {
  assert.equal(harness.config.analyticsPublishEnabled, undefined);
  assert.equal(harness.config.challengeCreateEnabled, undefined);
  assert.equal(harness.config.challengeClaimEnabled, undefined);

  const unauthenticated = await harness.app.inject({
    method: "GET",
    url: "/v1/operational-capabilities",
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);
  assert.equal(
    ApiErrorSchema.parse(unauthenticated.json()).code,
    "UNAUTHORIZED",
  );
  const invalidToken = await harness.app.inject({
    method: "GET",
    url: "/v1/operational-capabilities",
    headers: authorizationHeaders("invalid-token"),
  });
  assert.equal(invalidToken.statusCode, 401, invalidToken.body);
  assert.equal(ApiErrorSchema.parse(invalidToken.json()).code, "UNAUTHORIZED");

  const accessToken = await bootstrapUser();
  const databaseBefore = await snapshotDatabase(harness.database);

  const defaultResponse = await harness.app.inject({
    method: "GET",
    url: "/v1/operational-capabilities",
    headers: authorizationHeaders(accessToken),
  });
  assertCapabilitiesResponse(defaultResponse, {
    analyticsPublishEnabled: true,
    challengeCreateEnabled: true,
    challengeClaimEnabled: true,
  });

  for (const capabilities of [
    {
      analyticsPublishEnabled: false,
      challengeCreateEnabled: false,
      challengeClaimEnabled: false,
    },
    {
      analyticsPublishEnabled: true,
      challengeCreateEnabled: true,
      challengeClaimEnabled: false,
    },
    {
      analyticsPublishEnabled: false,
      challengeCreateEnabled: false,
      challengeClaimEnabled: true,
    },
  ]) {
    const config = { ...harness.config, ...capabilities };
    const database = createDatabase(config);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;

    try {
      app = await buildApp({ config, database });
      const response = await app.inject({
        method: "GET",
        url: "/v1/operational-capabilities",
        headers: authorizationHeaders(accessToken),
      });
      assertCapabilitiesResponse(response, capabilities);
    } finally {
      if (app !== undefined) {
        await app.close();
      } else {
        await database.close();
      }
    }
  }

  assert.deepEqual(await snapshotDatabase(harness.database), databaseBefore);
});
