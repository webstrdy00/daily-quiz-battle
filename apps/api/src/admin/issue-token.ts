import { loadConfig } from "../config.js";
import { createAdminAccessTokenService } from "./token.js";

const USAGE =
  "Usage: pnpm --filter @daily-quiz-battle/api admin:token -- --subject <value>";
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function parseSubject(args: string[]): string {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    throw new Error(USAGE);
  }

  if (args.length !== 2 || args[0] !== "--subject") {
    throw new Error(`Invalid arguments. ${USAGE}`);
  }

  const rawSubject = args[1]!;
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

  return subject;
}

async function main(): Promise<void> {
  const subject = parseSubject(process.argv.slice(2));
  const tokenService = createAdminAccessTokenService(loadConfig());
  const token = await tokenService.issue({
    actorSubject: subject,
    scopes: ["content:write"],
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
