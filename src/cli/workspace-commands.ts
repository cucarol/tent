import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { NodeFs } from "../fs/node-fs.js";
import { exportGraph } from "../fs/graph-export.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import { readWorkspaceSettings } from "../core/workspace-settings.js";
import { listHistoryChanges } from "../core/history-query.js";
import { checkGraph } from "../core/graph-check.js";
import {
  scanWorkspace,
  formatWorkspaceScan,
  workspaceScanCommitLimit,
} from "../core/workspace-scan.js";
import { readWorkspaceScanRepository, scanFileKind } from "../fs/workspace-scan.js";
import {
  inspectCurrentContext,
  makeContextBrief,
  formatContextBrief,
  inspectWorkspaceDrift,
} from "../core/context-brief.js";
import { canonicalSha256 } from "../core/canonical-digest.js";
import { pageItems } from "./reader-page.js";
import { cliErrorText, type ErrorContext } from "./error-text.js";
import type { NodeCommandResult, NodeCommandOptions } from "./node-commands.js";

export const workspaceHelpText = `tent workspace export --output <new-output-or-scratch-directory>
tent workspace changes [--from <commit>] [--to <commit>] [--limit <n>] [--cursor <cursor>]
tent workspace check [--json]
tent workspace brief [--role <roleId>] [--json]
tent workspace drift [--limit <n>] [--cursor <cursor>] [--json]
tent workspace scan [--commits <n>] [--json]
Accepts --workspace <root> and --json. check reports broken links, invalid material addresses, missing local files, unavailable Markdown material sections and Node documents whose disk and Tent Git presence differ (node-git-mismatch) without editing documents or capturing history. Exit 1 means issues or inspection errors; JSON remains on stdout. brief compares current local versions and returns at most 4 KiB, with behind Nodes first, then ahead Nodes. --role filters Card inputs; Node counts remain Workspace-wide. drift reports ahead and behind Nodes. Use node confirm after reviewing a Node; Tent records hashes itself.`;

export async function runWorkspaceCommand(
  sub: string,
  args: string[],
  globals: NodeCommandOptions = {},
): Promise<NodeCommandResult> {
  const errorContext: ErrorContext = { workspace: globals.workspace };
  try {
    if (["help", "--help", "-h"].includes(sub))
      return { exitCode: 0, stdout: workspaceHelpText + "\n", stderr: "" };
    if (!["export", "changes", "check", "brief", "drift", "scan"].includes(sub))
      throw new Error(workspaceHelpText);
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        output: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "string" },
        cursor: { type: "string" },
        role: { type: "string" },
        commits: { type: "string" },
        help: { type: "boolean", short: "h" },
        workspace: { type: "string" },
        json: { type: "boolean" },
      },
    });
    errorContext.workspace = values.workspace ?? globals.workspace;
    if (values.help || positionals[0] === "help")
      return { exitCode: 0, stdout: workspaceHelpText + "\n", stderr: "" };
    if (positionals.length) throw new Error(workspaceHelpText);
    if (values.role !== undefined && sub !== "brief")
      throw new Error("--role is only valid for workspace brief");
    if (values.commits !== undefined && sub !== "scan")
      throw new Error("--commits is only valid for workspace scan");
    if (
      sub === "scan" &&
      [values.output, values.from, values.to, values.limit, values.cursor].some(
        (value) => value !== undefined,
      )
    )
      throw new Error(workspaceHelpText);
    const commitLimit =
      sub === "scan"
        ? workspaceScanCommitLimit(
            values.commits === undefined ? undefined : Number(values.commits),
          )
        : undefined;
    if (
      sub === "export" &&
      (!values.output || values.from || values.to || values.limit || values.cursor)
    )
      throw new Error(workspaceHelpText);
    if (sub === "changes" && values.output) throw new Error(workspaceHelpText);
    if (
      sub === "brief" &&
      [values.output, values.from, values.to, values.limit, values.cursor].some(
        (value) => value !== undefined,
      )
    )
      throw new Error(workspaceHelpText);
    if (
      sub === "drift" &&
      [values.output, values.from, values.to].some((value) => value !== undefined)
    )
      throw new Error(workspaceHelpText);
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
    if (sub === "scan") {
      const result = await scanWorkspace(
        fs,
        roots.workspaceRoot,
        await readWorkspaceScanRepository(roots.workspaceRoot, commitLimit),
        scanFileKind,
        commitLimit,
      );
      return {
        exitCode: result.inspectionErrors.length ? 1 : 0,
        stdout:
          (values.json || globals.json ? JSON.stringify(result) : formatWorkspaceScan(result)) +
          "\n",
        stderr:
          values.json || globals.json
            ? ""
            : result.inspectionErrors
                .map((error) => `${error.node}: ${error.resource ?? "Node"}: ${error.reason}\n`)
                .join(""),
      };
    }
    if (sub === "brief") {
      const brief = makeContextBrief(
        await inspectCurrentContext(fs, roots.workspaceRoot, { roleId: values.role }),
        { roleId: values.role },
      );
      return {
        exitCode: 0,
        stdout:
          (values.json || globals.json ? JSON.stringify(brief) : formatContextBrief(brief)) + "\n",
        stderr: "",
      };
    }
    if (sub === "drift") {
      const inspected = await inspectWorkspaceDrift(fs);
      const result = pageItems(
        {
          items: inspected.items,
          revision: canonicalSha256(inspected),
          synchronizationUncertain: inspected.synchronizationUncertain,
        },
        "workspace.drift",
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
                  `${item.kind === "node-ahead" ? "ahead" : "behind"}  ${item.nodeId}  ${item.path.slice(item.path.lastIndexOf("/") + 1)}  ${item.reasons.join("; ")}`,
              ),
              ...(result.page.hasMore ? [`Continue with --cursor ${result.page.nextCursor}`] : []),
              ...(inspected.synchronizationUncertain
                ? [
                    "Some Nodes changed during inspection; synchronization findings are incomplete. Retry workspace drift.",
                  ]
                : []),
            ].join("\n") || "No observed drift.";
      return { exitCode: 0, stdout: output + "\n", stderr: "" };
    }
    if (sub === "check") {
      const result = await checkGraph(
        fs,
        roots.workspaceRoot,
        async (filename, directory?: boolean) => {
          try {
            const info = await stat(filename);
            return directory ? info.isDirectory() : info.isFile();
          } catch (error) {
            if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
              return false;
            throw error;
          }
        },
      );
      const output =
        values.json || globals.json
          ? JSON.stringify(result)
          : [
              `${result.documents} documents; ${result.issues.length} issues; ${result.errors.length} inspection errors.`,
              ...result.issues.map(
                (issue) =>
                  `${issue.path}: ${issue.kind}: ${"target" in issue ? issue.target : "state" in issue ? issue.state : (issue.resource ?? issue.field)} — ${issue.reason}`,
              ),
              ...result.errors.map((error) => `${error.path}: ${error.reason}`),
              ...result.notices.map(
                (notice) => `${notice.path}: ${notice.resource ?? notice.field} — ${notice.reason}`,
              ),
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
      stderr: `${cliErrorText(error, `tent workspace ${sub}`, errorContext)}\n`,
    };
  }
}
