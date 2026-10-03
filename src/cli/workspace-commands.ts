import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { NodeFs } from "../fs/node-fs.js";
import { exportGraph } from "../fs/graph-export.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import { readWorkspaceSettings } from "../core/workspace-settings.js";
import { listHistoryChanges } from "../core/history-query.js";
import { checkGraph } from "../core/graph-check.js";
import { pageItems } from "./reader-page.js";
import type { NodeCommandResult, NodeCommandOptions } from "./node-commands.js";

export const workspaceHelpText = `tent workspace export --output <new-output-or-scratch-directory>
tent workspace changes [--from <commit>] [--to <commit>] [--limit <n>] [--cursor <cursor>]
tent workspace check [--json]
Accepts --workspace <root> and --json. check reports broken links, invalid material addresses and missing local material files without writing or capturing history. Exit 1 means issues or inspection errors; JSON remains on stdout. Use node check separately to record material versions.`;

export async function runWorkspaceCommand(
  sub: string,
  args: string[],
  globals: NodeCommandOptions = {},
): Promise<NodeCommandResult> {
  try {
    if (["help", "--help", "-h"].includes(sub))
      return { exitCode: 0, stdout: workspaceHelpText + "\n", stderr: "" };
    if (!["export", "changes", "check"].includes(sub)) throw new Error(workspaceHelpText);
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        output: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "string" },
        cursor: { type: "string" },
        help: { type: "boolean", short: "h" },
        workspace: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (values.help || positionals[0] === "help")
      return { exitCode: 0, stdout: workspaceHelpText + "\n", stderr: "" };
    if (positionals.length) throw new Error(workspaceHelpText);
    if (
      sub === "export" &&
      (!values.output || values.from || values.to || values.limit || values.cursor)
    )
      throw new Error(workspaceHelpText);
    if (sub === "changes" && values.output) throw new Error(workspaceHelpText);
    if (
      sub === "check" &&
      [values.output, values.from, values.to, values.limit, values.cursor].some(
        (value) => value !== undefined,
      )
    )
      throw new Error(workspaceHelpText);
    const roots = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: values.workspace ?? globals.workspace,
    });
    const fs = new NodeFs(roots.systemRoot, "cli"),
      { workspaceId } = await readWorkspaceSettings(fs);
    if (!workspaceId)
      throw new Error(
        "Tent workspace identity is missing; explicitly initialize or convert this workspace",
      );
    if (sub === "check") {
      const result = await checkGraph(fs, roots.workspaceRoot, async (filename) => {
        try {
          return (await stat(filename)).isFile();
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return false;
          throw error;
        }
      });
      const output =
        values.json || globals.json
          ? JSON.stringify(result)
          : [
              `${result.documents} documents; ${result.issues.length} issues; ${result.errors.length} inspection errors.`,
              ...result.issues.map(
                (issue) =>
                  `${issue.path}: ${issue.kind}: ${"target" in issue ? issue.target : (issue.resource ?? issue.field)} — ${issue.reason}`,
              ),
              ...result.errors.map((error) => `${error.path}: ${error.reason}`),
            ].join("\n");
      return {
        exitCode: result.issues.length || result.errors.length ? 1 : 0,
        stdout: output + "\n",
        stderr: "",
      };
    }
    if (sub === "changes") {
      const range = { from: values.from, to: values.to };
      const result = pageItems(
        { items: await listHistoryChanges(fs, range), scope: { workspaceId, ...range } },
        "workspace.changes",
        {
          limit: values.limit === undefined ? undefined : Number(values.limit),
          cursor: values.cursor,
        },
      );
      const output =
        values.json || globals.json
          ? JSON.stringify(result)
          : [
              ...result.items.map(
                (item) =>
                  `${item.commit}  ${item.operation ?? "external commit"}  ${item.objectIds.join(", ")}`,
              ),
              ...(result.page.hasMore ? [`Continue with --cursor ${result.page.nextCursor}`] : []),
            ].join("\n") || "No changes.";
      return { exitCode: 0, stdout: output + "\n", stderr: "" };
    }
    const result = await exportGraph(
      { ...roots, workspaceId, env: { fs } },
      { outputDir: values.output! },
    );
    return {
      exitCode: 0,
      stdout:
        (values.json || globals.json
          ? JSON.stringify(result)
          : `Exported Tent to ${values.output}`) + "\n",
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
