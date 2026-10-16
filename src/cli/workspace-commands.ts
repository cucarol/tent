import { workspaceReadPaths } from "./read-paths.js";
import { captureNativeNodeEdits } from "../core/graph/node-native-capture.js";
import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { NodeFs } from "../fs/node-fs.js";
import { exportGraph } from "../fs/graph-export.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import { readWorkspaceSettings } from "../core/workspace/workspace-settings.js";
import { checkGraph } from "../core/check/graph-check.js";
import { scanWorkspace, formatWorkspaceScan } from "../core/check/workspace-scan.js";
import {
  readWorkspaceScanRepository,
  readModuleMapRepository,
  scanFileKind,
} from "../fs/workspace-scan.js";
import {
  checkWorkspaceModules,
  formatWorkspaceModules,
} from "../core/check/workspace-module-map.js";
import {
  inspectCurrentContext,
  makeContextBrief,
  formatContextBrief,
  inspectWorkspaceDrift,
} from "../core/read/context-brief.js";
import { canonicalSha256 } from "../core/base/canonical-digest.js";
import { pageItems } from "./reader-page.js";
import { cliErrorText, type ErrorContext } from "./error-text.js";
import type { NodeCommandResult, NodeCommandOptions } from "./node-commands.js";

export const workspaceHelpText = `tent workspace export --output <new-output-or-scratch-directory>
tent workspace check [--json]
tent workspace check-modules [--json]
tent workspace brief [--role <roleId>] [--json]
tent workspace drift [--limit <n>] [--cursor <cursor>] [--json]
tent workspace scan [--json]
Accepts --workspace <root> and --json. check reports broken links, invalid material addresses, missing local files, unavailable Markdown material sections and Node documents whose disk and Tent Git presence differ (node-git-mismatch) after collecting valid native edits; invalid files remain untouched. Exit 1 means issues or inspection errors; JSON remains on stdout. check-modules checks module coverage, size, imports and cochange without collecting edits; a clean map emits no text. brief lists all invalid Nodes and pending Cards, then prioritizes ahead and changed sources; optional detail fits 4 KiB. --role filters Card inputs; Node counts remain Workspace-wide. drift reports ahead and behind Nodes. Use node confirm after reviewing a Node; Tent records hashes itself.`;

export async function runWorkspaceCommand(
  sub: string,
  args: string[],
  globals: NodeCommandOptions = {},
): Promise<NodeCommandResult> {
  const errorContext: ErrorContext = { workspace: globals.workspace };
  try {
    if (["help", "--help", "-h"].includes(sub))
      return { exitCode: 0, stdout: workspaceHelpText + "\n", stderr: "" };
    if (!["export", "check", "check-modules", "brief", "drift", "scan"].includes(sub))
      throw new Error(workspaceHelpText);
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        output: { type: "string" },
        limit: { type: "string" },
        cursor: { type: "string" },
        role: { type: "string" },
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
    if (
      sub === "scan" &&
      [values.output, values.limit, values.cursor].some((value) => value !== undefined)
    )
      throw new Error(workspaceHelpText);
    if (sub === "export" && (!values.output || values.limit || values.cursor))
      throw new Error(workspaceHelpText);
    if (
      sub === "brief" &&
      [values.output, values.limit, values.cursor].some((value) => value !== undefined)
    )
      throw new Error(workspaceHelpText);
    if (sub === "drift" && [values.output].some((value) => value !== undefined))
      throw new Error(workspaceHelpText);
    if (
      ["check", "check-modules"].includes(sub) &&
      [values.output, values.limit, values.cursor].some((value) => value !== undefined)
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
    if (sub === "check-modules") {
      const result = await checkWorkspaceModules(
        fs,
        roots.workspaceRoot,
        await readModuleMapRepository(roots.workspaceRoot),
      );
      return {
        exitCode:
          result.issues.length ||
          result.inspectionErrors.length ||
          result.importIssues.length ||
          result.unassignedImports.length
            ? 1
            : 0,
        stdout:
          values.json || globals.json
            ? JSON.stringify(result) + "\n"
            : formatWorkspaceModules(result),
        stderr:
          values.json || globals.json
            ? ""
            : [
                ...result.inspectionErrors.map(
                  (error) => `${error.node}: ${error.resource ?? "Node"}: ${error.reason}`,
                ),
                ...result.importIssues.map(
                  (error) => `${error.file}: ${error.specifier ?? "imports"}: ${error.reason}`,
                ),
                ...result.unassignedImports.map(
                  (error) => `${error.from} -> ${error.to}: ${error.reason}`,
                ),
              ]
                .map((line) => line + "\n")
                .join(""),
      };
    }
    if (sub === "scan") {
      const result = await scanWorkspace(
        fs,
        roots.workspaceRoot,
        await readWorkspaceScanRepository(roots.workspaceRoot),
        scanFileKind,
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
    const captureFs = new NodeFs(roots.systemRoot, "cli");
    const nodes = captureNativeNodeEdits(captureFs).then((result) => {
      fs.invalidNodeEdits = captureFs.invalidNodeEdits;
      return result;
    });
    if (sub === "brief") {
      const brief = makeContextBrief(
        await inspectCurrentContext(fs, {
          roleId: values.role,
          nodes,
        }),
        { roleId: values.role },
      );
      return {
        exitCode: 0,
        stdout:
          (values.json || globals.json ? JSON.stringify(brief) : formatContextBrief(brief)) + "\n",
        stderr: "",
      };
    }
    const { invalidNodes: invalidNativeNodes } = await nodes;
    if (sub === "drift") {
      const inspected = await inspectWorkspaceDrift(fs);
      const result = pageItems(
        {
          items: workspaceReadPaths(inspected.items, roots.workspaceRoot),
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
                  `${item.kind === "node-ahead" ? "ahead" : "behind"}  ${item.nodeId}  ${item.path}  ${item.reasons.join("; ")}`,
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
      const checked = await checkGraph(
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
      const result = {
        ...checked,
        issues: checked.issues.map((issue) => ({ ...issue, path: `.tent/${issue.path}` })),
        errors: checked.errors.map((error) => ({ ...error, path: `.tent/${error.path}` })),
        notices: checked.notices.map((notice) => ({ ...notice, path: `.tent/${notice.path}` })),
      };
      for (const invalid of invalidNativeNodes)
        if (!result.errors.some((error) => error.path === invalid.path))
          result.errors.push({
            path: invalid.path,
            reason: invalid.reason,
          });
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
