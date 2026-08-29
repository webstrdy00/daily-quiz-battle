import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadConfig } from "../config.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(currentDirectory, "../../migrations");

async function migrate(): Promise<void> {
  const config = loadConfig();
  const sql = postgres(config.databaseUrl, { max: 1, prepare: false });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS app_migrations (
        filename text PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const filename of files) {
      const migrationSql = await readFile(
        resolve(migrationDirectory, filename),
        "utf8",
      );
      const checksum = createHash("sha256").update(migrationSql).digest("hex");
      const existing = await sql<{ checksum: string }[]>`
        SELECT checksum
        FROM app_migrations
        WHERE filename = ${filename}
      `;

      if (existing[0] !== undefined) {
        if (existing[0].checksum !== checksum) {
          throw new Error(`Applied migration was modified: ${filename}`);
        }
        console.log(`Migration already applied: ${filename}`);
        continue;
      }

      await sql.begin(async (transaction) => {
        await transaction.unsafe(migrationSql);
        await transaction`
          INSERT INTO app_migrations (filename, checksum)
          VALUES (${filename}, ${checksum})
        `;
      });

      console.log(`Migration applied: ${filename}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await migrate();
