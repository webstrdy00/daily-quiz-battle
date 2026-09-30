import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import {
  ADMIN_ACCESS_TOKEN_SCOPES,
  createAdminAccessTokenService,
  isValidAdminScopes,
  isValidAdminSubject,
} from "./token.js";

const USAGE =
  "Usage: pnpm --filter @daily-quiz-battle/api admin:token -- --subject <value> --scope <comma-separated scopes: content:write,content:void,reports:read,reports:triage>";
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

interface ParsedArguments {
  subject: string;
  scopes: string[];
}

export function parseArguments(args: string[]): ParsedArguments {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    throw new Error(USAGE);
  }

  if (args.length === 0 || args.length % 2 !== 0) {
    throw new Error(`Invalid arguments. ${USAGE}`);
  }

  let rawSubject: string | undefined;
  let rawScopes: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1]!;

    if (option === "--subject" && rawSubject === undefined) {
      rawSubject = value;
      continue;
    }

    if (option === "--scope" && rawScopes === undefined) {
      rawScopes = value;
      continue;
    }

    throw new Error(`Invalid arguments. ${USAGE}`);
  }

  if (rawSubject === undefined || rawScopes === undefined) {
    throw new Error(`Invalid arguments. ${USAGE}`);
  }

  const subject = rawSubject.trim();
  if (
    !isValidAdminSubject(subject) ||
    CONTROL_CHARACTER_PATTERN.test(rawSubject)
  ) {
    throw new Error(
      "Invalid --subject: use 1 to 100 characters without control characters.",
    );
  }

  const scopes = rawScopes.split(",");

  if (!isValidAdminScopes(scopes)) {
    throw new Error(
      `Invalid --scope: choose from ${ADMIN_ACCESS_TOKEN_SCOPES.join(",")} without duplicates.`,
    );
  }

  return { subject, scopes };
}

async function main(): Promise<void> {
  const { subject, scopes } = parseArguments(process.argv.slice(2));
  const tokenService = createAdminAccessTokenService(loadConfig());
  const token = await tokenService.issue({
    actorSubject: subject,
    scopes,
  });

  process.stdout.write(`${token}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown token issuance error";
    process.stderr.write(`Admin token issuance failed: ${message}\n`);
    process.exitCode = 1;
  }
}
