import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { importGitHistory } from "../fs/import-git-history.js";

export async function migrateHistoryCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string" },
      output: { type: "string" },
      report: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    return "node migrate-history.mjs --source <offline-copy/.tent> --output <new-copy/.tent> [--report <new-audit.json>]\n";
  if (!values.source || !values.output)
    throw Error("Migration requires --source <offline .tent> and --output <new .tent>");
  const report = path.resolve(
    values.report ?? path.join(path.dirname(path.resolve(values.output)), "migration-audit.json"),
  );
  if (
    await fs.access(report).then(
      () => true,
      () => false,
    )
  )
    throw Error("Migration audit output already exists");
  const result = await importGitHistory(values.source, values.output);
  await fs.mkdir(path.dirname(report), { recursive: true });
  await fs.writeFile(report, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return (
    JSON.stringify({
      sourceHead: result.sourceHead,
      targetHead: result.targetHead,
      events: result.events,
      pins: result.pins.length,
      uncaptured: result.uncaptured.length,
      report,
    }) + "\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void migrateHistoryCommand(process.argv.slice(2))
    .then((text) => process.stdout.write(text))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
