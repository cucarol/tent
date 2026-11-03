import * as path from "node:path";
import { parseArgs } from "node:util";
import { cliErrorText } from "./error-text.js";

export const LOAD_HELP = `Usage: tent load <path>... [--json]
Nodes for these files: those covering them, whole or by a section, then the direct prompts of each and of every goal above it, nearest first. Paths are relative to the current directory. Read the Nodes it lists with your own tools.
--workspace <path> picks the Workspace; --json prints JSON.`;

export async function runLoadCommand(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let workspace: string | undefined;
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        workspace: { type: "string" },
      },
    });
    workspace = values.workspace;
    if (values.help) return { exitCode: 0, stdout: LOAD_HELP + "\n", stderr: "" };
    if (!positionals.length) return { exitCode: 1, stdout: "", stderr: LOAD_HELP + "\n" };
    const { resolveWorkspacePaths } = await import("./workspace-path.js");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({ workspace });
    const { createTurnPathResolver } = await import("../core/workspace/git-checkout.js");
    const resolver = await createTurnPathResolver(workspaceRoot, process.cwd());
    const base = resolver.checkoutWorkspaceRoot ?? workspaceRoot;
    const files: string[] = [];
    for (const value of positionals) {
      const relative = path.relative(base, path.resolve(value)).split(path.sep).join("/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${value} is outside the Workspace at ${base}.\n`,
        };
      files.push(relative);
    }
    const { NodeFs } = await import("../fs/node-fs.js");
    const fs = new NodeFs(systemRoot, "cli");
    try {
      await (await import("../core/graph/node-native-capture.js")).captureNativeNodeEdits(fs);
      const { loadNodeCatalog } = await import("../core/graph/node-catalog.js");
      const { buildStopCoverageIndex } = await import("../core/return/stop-coverage.js");
      const { selectLoadNodes, formatLoadNodes } = await import("../core/read/load-nodes.js");
      const catalog = await loadNodeCatalog(fs);
      const result = selectLoadNodes(
        catalog,
        buildStopCoverageIndex(catalog, systemRoot, workspaceRoot),
        systemRoot,
        files,
      );
      return {
        exitCode: 0,
        stdout:
          (values.json
            ? JSON.stringify({ files, ...result, workspaceRoot }, null, 2)
            : formatLoadNodes(files, result)) + "\n",
        stderr: "",
      };
    } finally {
      await fs.close();
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: cliErrorText(error, "tent load", { workspace }) + "\n",
    };
  }
}
