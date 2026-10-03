// Develop the Web UI against a real workspace: a watching build plus the `tent ui` service.
// Usage: npm run ui:dev -- --workspace <dir> [--port <n>]. Writes go to that workspace.
import { spawn } from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startUiServer } from "../src/ui-server/server.js";
import { defaultWorkspacesFile } from "../src/ui-server/workspaces.js";

const { values } = parseArgs({
  options: { workspace: { type: "string" }, port: { type: "string" } },
});
if (!values.workspace) throw new Error("Usage: ui:dev -- --workspace <dir> [--port <n>]");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const build = spawn(process.execPath, [path.join(root, "scripts/ui-build.mjs"), "--watch"], {
  stdio: "inherit",
});
const server = await startUiServer({
  workspaceRoot: values.workspace,
  staticDir: path.join(root, "ui-dist"),
  workspacesFile: defaultWorkspacesFile(),
  port: values.port ? Number(values.port) : undefined,
});
console.log(`Tent UI: ${server.url}`);

const stop = async () => {
  build.kill();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
