import { loadConfig } from "../config.js";
import { runOperations } from "./runner.js";

try {
  const args = process.argv.slice(2);
  const once = args.length === 1 && args[0] === "--once";
  if (args.length > 0 && !once) {
    throw new Error("Invalid operations scheduler arguments");
  }

  if (!(await runOperations(loadConfig(), once ? "once" : "schedule"))) {
    process.exitCode = 1;
  }
} catch {
  process.stderr.write(
    `${JSON.stringify({ component: "operations_scheduler", status: "failed" })}\n`,
  );
  process.exitCode = 1;
}
