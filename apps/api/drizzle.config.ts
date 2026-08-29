import { defineConfig } from "drizzle-kit";

const localDatabaseUrl =
  "postgres://daily_quiz:daily_quiz_local@localhost:5432/daily_quiz";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations/generated",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? localDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
