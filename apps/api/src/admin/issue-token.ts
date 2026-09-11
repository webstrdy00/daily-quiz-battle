import { loadConfig } from "../config.js";
import { createAdminAccessTokenService } from "./token.js";

const USAGE =
  "Usage: pnpm --filter @daily-quiz-battle/api admin:token -- --subject <value> [--scope content:write,content:void,reports:read,reports:triage]";
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const ALLOWED_SCOPES = [
  "content:write",
  "content:void",
  "reports:read",
  "reports:triage",
] as const;
type AllowedScope = (typeof ALLOWED_SCOPES)[number];

interface ParsedArguments {
  subject: string;
  scopes: AllowedScope[];
}

function parseArguments(args: string[]): ParsedArguments {
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

  if (rawSubject === undefined) {
    throw new Error(`Invalid arguments. ${USAGE}`);
  }

  const subject = rawSubject.trim();
  const subjectLength = Array.from(subject).length;

  if (
    subjectLength === 0 ||
    subjectLength > 100 ||
    CONTROL_CHARACTER_PATTERN.test(rawSubject)
  ) {
    throw new Error(
      "Invalid --subject: use 1 to 100 characters without control characters.",
    );
  }

  const scopes =
    rawScopes === undefined
      ? [...ALLOWED_SCOPES]
      : rawScopes.split(",").map((scope) => {
          if (!ALLOWED_SCOPES.includes(scope as AllowedScope)) {
            throw new Error(
              `Invalid --scope: allowed values are ${ALLOWED_SCOPES.join(",")}.`,
            );
          }

          return scope as AllowedScope;
        });

  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) {
    throw new Error(
      `Invalid --scope: use each of ${ALLOWED_SCOPES.join(",")} at most once.`,
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

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unknown token issuance error";
  process.stderr.write(`Admin token issuance failed: ${message}\n`);
  process.exitCode = 1;
}
