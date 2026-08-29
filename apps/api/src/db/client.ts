import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AppConfig } from "../config.js";
import * as schema from "./schema.js";

export type SqlClient = ReturnType<typeof postgres>;

export interface Database {
  client: SqlClient;
  orm: PostgresJsDatabase<typeof schema>;
  close(): Promise<void>;
}

export function createDatabase(config: AppConfig): Database {
  const client = postgres(config.databaseUrl, {
    max: config.appEnvironment === "development" ? 5 : 20,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  const orm = drizzle(client, { schema });

  return {
    client,
    orm,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}
