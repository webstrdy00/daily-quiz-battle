import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ApiErrorSchema,
  BootstrapResponseSchema,
  OperationalCapabilitiesResponseSchema,
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
  analyticsPublishEnabled: boolean,
): void {
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body, { analyticsPublishEnabled });
  assert.deepEqual(OperationalCapabilitiesResponseSchema.parse(body), {
    analyticsPublishEnabled,
  });
}

test("operational capabilities require authentication and expose only the configured analytics capability without database mutation", async () => {
  assert.equal(harness.config.analyticsPublishEnabled, undefined);

  const unauthenticated = await harness.app.inject({
    method: "GET",
    url: "/v1/operational-capabilities",
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);
  assert.equal(
    ApiErrorSchema.parse(unauthenticated.json()).code,
    "UNAUTHORIZED",
  );

  const accessToken = await bootstrapUser();
  const databaseBefore = await snapshotDatabase(harness.database);

  const defaultResponse = await harness.app.inject({
    method: "GET",
    url: "/v1/operational-capabilities",
    headers: authorizationHeaders(accessToken),
  });
  assertCapabilitiesResponse(defaultResponse, true);

  const disabledConfig = {
    ...harness.config,
    analyticsPublishEnabled: false,
  };
  const disabledDatabase = createDatabase(disabledConfig);
  let disabledApp: Awaited<ReturnType<typeof buildApp>> | undefined;

  try {
    disabledApp = await buildApp({
      config: disabledConfig,
      database: disabledDatabase,
    });
    const disabledResponse = await disabledApp.inject({
      method: "GET",
      url: "/v1/operational-capabilities",
      headers: authorizationHeaders(accessToken),
    });
    assertCapabilitiesResponse(disabledResponse, false);
  } finally {
    if (disabledApp !== undefined) {
      await disabledApp.close();
    } else {
      await disabledDatabase.close();
    }
  }

  assert.deepEqual(await snapshotDatabase(harness.database), databaseBefore);
});
