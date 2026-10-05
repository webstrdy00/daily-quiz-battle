#!/usr/bin/env node
// Public-schema schema + data only: excludes Supabase auth/storage, roles and grants.
// Usage:
// node ops/backup-production.mjs backup --url-file PATH --key-file PATH --output-dir PATH --ca-file PATH
// node ops/backup-production.mjs restore --archive PATH --key-file PATH
// Key file: exactly 32 raw bytes, or 64 hexadecimal characters with optional whitespace.
// URL file: postgresql://USER:PASSWORD@REMOTE_HOST:5432/postgres?sslmode=verify-full
// Use a direct/session endpoint, never a transaction pooler. Password must be URL-encoded.
// Published backup directories contain archive.dqb and manifest.json; directory rename is atomic.
// Keep keys separate from archives. No retention, scheduler or off-host replication is provided.
// Dumps/decrypted archives stay in RAM (256 MiB maximum); authenticated archives are trusted SQL.
// Graceful SIGINT/SIGTERM waits for the active command before cleanup. SIGKILL/host loss cannot
// guarantee cleanup; only daily_quiz_restore_<32hex> databases created by this run are dropped.
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const HEADER = Buffer.from("DQB-AES256GCM-v1\n");
const LIMIT = 256 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180_000;
const CONTAINER = "daily-quiz-battle-postgres";
const USER = "daily_quiz";
let interrupted = false;

export function parseKey(bytes) {
  if (bytes.length === 32) return Buffer.from(bytes);
  const hex = bytes.toString("utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Invalid key file.");
  return Buffer.from(hex, "hex");
}

export function encryptArchive(plain, key) {
  if (!plain.length || plain.length > LIMIT)
    throw new Error("Invalid dump size.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(HEADER);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([HEADER, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptArchive(archive, key) {
  const start = HEADER.length;
  if (
    archive.length <= start + 28 ||
    archive.length > LIMIT + start + 28 ||
    !archive.subarray(0, start).equals(HEADER)
  )
    throw new Error("Invalid encrypted archive.");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      archive.subarray(start, start + 12),
    );
    decipher.setAAD(HEADER);
    decipher.setAuthTag(archive.subarray(start + 12, start + 28));
    const plain = Buffer.concat([
      decipher.update(archive.subarray(start + 28)),
      decipher.final(),
    ]);
    if (!plain.subarray(0, 5).equals(Buffer.from("PGDMP"))) throw new Error();
    return plain;
  } catch {
    throw new Error("Archive authentication or format validation failed.");
  }
}

export function parseSource(text) {
  try {
    const url = new URL(text.trim());
    const host = url.hostname.toLowerCase();
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.includes(":") ||
      /^\d+(\.\d+)*$/.test(host) ||
      (url.port && url.port !== "5432") ||
      url.pathname !== "/postgres" ||
      url.hash ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      [...url.searchParams.keys()].some((key) => key !== "sslmode")
    )
      throw new Error();
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (/[\x00-\x1f\x7f]/.test(user + password)) throw new Error();
    url.username = "";
    url.password = "";
    url.searchParams.set("sslrootcert", "/backup-ca.crt");
    return { dbname: url.toString(), user, password };
  } catch {
    throw new Error(
      "Invalid source URL: require a remote session endpoint on port 5432 with sslmode=verify-full.",
    );
  }
}

// Never relay docker/PostgreSQL stderr: it can contain credentials, SQL or private data.
function docker(
  args,
  {
    input,
    env = {},
    allowInterrupted = false,
    timeoutMs = COMMAND_TIMEOUT_MS,
  } = {},
) {
  if (interrupted && !allowInterrupted)
    return Promise.reject(new Error("Interrupted."));
  return new Promise((accept, reject) => {
    const child = spawn("docker", args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(Buffer.concat(chunks));
    };
    const fail = (message) => {
      if (settled) return;
      finish(new Error(message));
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail("Docker/PostgreSQL command timed out."),
      Math.min(timeoutMs, COMMAND_TIMEOUT_MS),
    );
    child.on("error", () => fail("Docker/PostgreSQL command failed."));
    child.stdin.on("error", () => fail("Docker/PostgreSQL command failed."));
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > LIMIT) {
        fail("Docker/PostgreSQL command failed.");
      } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      finish(
        code !== 0 ? new Error("Docker/PostgreSQL command failed.") : null,
      );
    });
    child.stdin.end(input);
  });
}

export async function ensureDockerReady({
  run = docker,
  wait = delay,
  platform = process.platform,
  now = () => performance.now(),
} = {}) {
  // Include the initial probe and Desktop startup in the same readiness budget.
  const deadline = now() + 180_000;
  const probe = async () => {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    try {
      await run(["info"], { timeoutMs: Math.min(10_000, remaining) });
      return now() <= deadline;
    } catch {
      return false;
    }
  };
  if (await probe()) return;
  if (interrupted) throw new Error("Interrupted.");
  if (platform !== "win32") throw new Error("Docker is not ready.");
  const remaining = deadline - now();
  if (remaining > 0) {
    try {
      await run(["desktop", "start", "--detach"], {
        timeoutMs: Math.min(30_000, remaining),
      });
    } catch {
      throw new Error("Docker Desktop could not be started.");
    }
  }
  while (now() < deadline) {
    if (interrupted) throw new Error("Interrupted.");
    if (await probe()) return;
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(5_000, remaining));
  }
  throw new Error("Docker readiness timed out.");
}

async function backup(options, key) {
  const source = parseSource(await readFile(options["url-file"], "utf8"));
  const ca = resolve(options["ca-file"]);
  // Docker --mount uses commas as separators. Reject ambiguous paths before spawning.
  if (ca.includes(",") || /[\r\n]/.test(ca))
    throw new Error("Invalid CA path.");
  await readFile(ca);
  await ensureDockerReady();
  const plain = await docker(
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${ca},target=/backup-ca.crt,readonly`,
      "-e",
      "PGPASSWORD",
      "-e",
      "PGUSER",
      "postgres:18.6-alpine",
      "pg_dump",
      `--dbname=${source.dbname}`,
      "--schema=public",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--serializable-deferrable",
    ],
    { env: { PGPASSWORD: source.password, PGUSER: source.user } },
  );
  let encrypted;
  try {
    encrypted = encryptArchive(plain, key);
  } finally {
    plain.fill(0);
  }
  if (interrupted) throw new Error("Interrupted.");
  const createdAt = new Date().toISOString();
  const name = `daily-quiz-backup-${createdAt.replace(/[:.]/g, "-")}-${randomBytes(16).toString("hex")}`;
  const output = resolve(options["output-dir"]);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const staging = resolve(output, `.${name}.partial`);
  const destination = resolve(output, name);
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(resolve(staging, "archive.dqb"), encrypted, {
      flag: "wx",
      mode: 0o600,
    });
    const manifest = {
      format: "DQB-AES256GCM-v1",
      createdAt,
      archive: "archive.dqb",
      sha256: createHash("sha256").update(encrypted).digest("hex"),
      bytes: encrypted.length,
      scope: {
        schemas: ["public"],
        includes: ["schema", "data"],
        excludes: ["auth", "storage", "roles", "ownership", "grants"],
      },
    };
    await writeFile(
      resolve(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    if (interrupted) throw new Error("Interrupted.");
    await rename(staging, destination);
    // Return only generated names, never operator-provided paths.
    return { backup: name, ...manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function restore(options, key) {
  // Authenticate completely before even inspecting Docker or creating a database.
  const plain = decryptArchive(await readFile(options.archive), key);
  const database = `daily_quiz_restore_${randomBytes(16).toString("hex")}`;
  let owned = false;
  const sql = (query) =>
    docker([
      "exec",
      CONTAINER,
      "psql",
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      USER,
      "-d",
      database,
      "-c",
      query,
    ]);
  try {
    const status = await docker([
      "inspect",
      "--format",
      "{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}",
      CONTAINER,
    ]);
    if (status.toString().trim() !== "true|healthy")
      throw new Error("Local restore container is not healthy.");
    await docker([
      "exec",
      CONTAINER,
      "createdb",
      "-U",
      USER,
      "--template=template0",
      database,
    ]);
    owned = true;
    await sql("DROP SCHEMA public;");
    await docker(
      [
        "exec",
        "-i",
        CONTAINER,
        "pg_restore",
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-acl",
        "-U",
        USER,
        `--dbname=${database}`,
      ],
      { input: plain },
    );
    const migrationCount = JSON.parse(
      (await sql("SELECT count(*) FROM public.app_migrations;")).toString(),
    );
    const tables = JSON.parse(
      (
        await sql(
          "SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]'::json) FROM pg_catalog.pg_tables WHERE schemaname = 'public';",
        )
      ).toString(),
    );
    const rowCounts = {};
    for (const table of tables) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      rowCounts[table] = JSON.parse(
        (await sql(`SELECT count(*) FROM public.${quoted};`)).toString(),
      );
    }
    if (interrupted) throw new Error("Interrupted.");
    return {
      localRestore: true,
      migrationCount,
      tables,
      rowCounts,
      temporaryDatabaseRemoved: true,
    };
  } finally {
    plain.fill(0);
    if (owned) {
      await docker(
        [
          "exec",
          CONTAINER,
          "dropdb",
          "--if-exists",
          "--force",
          "-U",
          USER,
          database,
        ],
        { allowInterrupted: true },
      );
    }
  }
}

export async function main(argv) {
  const [command, ...args] = argv;
  const required =
    command === "backup"
      ? ["url-file", "key-file", "output-dir", "ca-file"]
      : command === "restore"
        ? ["archive", "key-file"]
        : [];
  const options = Object.create(null);
  if (!required.length || args.length !== required.length * 2)
    throw new Error(
      "Invalid command or options; see usage in ops/backup-production.mjs.",
    );
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i].slice(2);
    if (
      !args[i].startsWith("--") ||
      !required.includes(flag) ||
      options[flag] ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("Invalid command options.");
    options[flag] = args[i + 1];
  }
  const key = parseKey(await readFile(options["key-file"]));
  try {
    return command === "backup"
      ? await backup(options, key)
      : await restore(options, key);
  } finally {
    key.fill(0);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const stop = () => {
    interrupted = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2))));
  } catch {
    console.error(
      "Production backup operation failed; no credentials or database diagnostics are displayed.",
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
