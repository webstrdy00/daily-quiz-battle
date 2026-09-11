import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { loadConfig } from "../config.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const defaultMigrationDirectory = resolve(currentDirectory, "../../migrations");

type MigrationLogger = (message: string) => void;

export interface MigrationOptions {
  directory?: string;
  log?: MigrationLogger;
}

export async function runMigrations(
  databaseUrl: string,
  options: MigrationOptions = {},
): Promise<void> {
  const directory = options.directory ?? defaultMigrationDirectory;
  const log = options.log ?? console.log;
  const sql = postgres(databaseUrl, { max: 1, prepare: false });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS app_migrations (
        filename text PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const filename of files) {
      const migrationSql = await readFile(resolve(directory, filename), "utf8");
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
        log(`Migration already applied: ${filename}`);
        continue;
      }

      await sql.begin(async (transaction) => {
        await transaction.unsafe(migrationSql);
        await transaction`
          INSERT INTO app_migrations (filename, checksum)
          VALUES (${filename}, ${checksum})
        `;
      });

      log(`Migration applied: ${filename}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return (
    entryPath !== undefined &&
    import.meta.url === pathToFileURL(resolve(entryPath)).href
  );
}

if (isMainModule()) {
  await runMigrations(loadConfig().databaseUrl);
}
