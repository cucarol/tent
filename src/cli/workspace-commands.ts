import { transactionResult } from "./transaction-result.js";
import { workspaceReadPaths } from "./read-paths.js";
import { captureNativeNodeEdits } from "../core/graph/node-native-capture.js";
import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { NodeFs } from "../fs/node-fs.js";
import { withDocumentHeaderCache } from "../fs/document-header-cache.js";
import { exportGraph } from "../fs/graph-export.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import { readWorkspaceSettings } from "../core/workspace/workspace-settings.js";
import { checkGraph } from "../core/check/graph-check.js";
import { scanWorkspace, formatWorkspaceScan } from "../core/check/workspace-scan.js";
import { prepareWorkspaceDraft, formatWorkspaceDraft } from "../core/check/workspace-draft.js";
import { formatModuleImportIssues } from "../core/check/module-map.js";
import {
  readWorkspaceScanRepository,
  readModuleMapRepository,
  scanFileKind,
  writeWorkspaceDraft,
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
import { cliErrorText, unknownCommandError, type ErrorContext } from "./error-text.js";
import type { NodeCommandResult, NodeCommandOptions } from "./node-commands.js";

const WORKSPACE_COMMANDS = ["export", "check", "check-modules", "brief", "drift", "scan"];

export const workspaceHelpText = `tent workspace — the whole Workspace at once

  tent workspace brief [--role <role-id>] [--json]
  tent workspace check [--json]
  tent workspace drift [--limit <n>] [--cursor <cursor>] [--json]
  tent workspace scan [--draft <new-file>] [--json]
  tent workspace check-modules [--json]
  tent workspace export --output <new-directory>

brief: where to start. Counts, invalid Nodes and waiting Cards; for ahead and behind Nodes only their counts, since drift lists them. Every other list shows up to 10 items, then its total and the command that lists the rest. --role keeps only that Role's Cards.
check: broken links, invalid or missing materials, missing Markdown sections, and Node files whose disk and Tent history presence differ after valid native edits are collected. Exits 1 when it finds any; JSON still goes to stdout.
drift: every ahead and behind Node, in pages.
scan: drafts a module map from the code; --draft saves it as a write-many batch.
check-modules: checks the module map for coverage, size, imports and files that change together. Prints nothing when the map is clean.
export: copies the context graph and its SQLite history to a new directory.
When a behind Node still holds, run tent node confirm after reviewing it; Tent records the versions itself.
--workspace <path> picks the Workspace.`;

export async function runWorkspaceCommand(
  sub: string,
  args: string[],
  globals: NodeCommandOptions = {},
): Promise<NodeCommandResult> {
  return transactionResult((opened) => runWorkspaceCommandOpened(sub, args, globals, opened));
}

async function runWorkspaceCommandOpened(
  sub: string,
  args: string[],
  globals: NodeCommandOptions,
  opened: (fs: NodeFs) => Promise<void>,
): Promise<NodeCommandResult> {
  const errorContext: ErrorContext = { workspace: globals.workspace };
  try {
    if (["help", "--help", "-h"].includes(sub))
      return { exitCode: 0, stdout: workspaceHelpText + "\n", stderr: "" };
    if (!WORKSPACE_COMMANDS.includes(sub))
      throw unknownCommandError("tent workspace", sub, WORKSPACE_COMMANDS);
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        output: { type: "string" },
        draft: { type: "string" },
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
    if (values.draft !== undefined && sub !== "scan")
      throw new Error("--draft is only valid for workspace scan");
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
    const fs = new NodeFs(roots.systemRoot, "cli");
    await opened(fs);
    const { workspaceId } = await readWorkspaceSettings(fs);
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
          result.issues.length || result.inspectionErrors.length || result.unassignedImports.length
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
                ...(result.importIssues.length
                  ? [formatModuleImportIssues(result.importIssues.length)]
                  : []),
                ...result.unassignedImports.map(
                  (error) => `${error.from} -> ${error.to}: ${error.reason}`,
                ),
              ]
                .map((line) => line + "\n")
                .join(""),
      };
    }
    if (sub === "scan") {
      const draftRepository =
        values.draft !== undefined ? await readModuleMapRepository(roots.workspaceRoot) : undefined;
      const repository =
        draftRepository ?? (await readWorkspaceScanRepository(roots.workspaceRoot));
      const result = await scanWorkspace(fs, roots.workspaceRoot, repository, scanFileKind);
      if (values.draft !== undefined) {
        if (!values.draft.trim()) throw new Error("--draft requires a new file path");
        const draft = await prepareWorkspaceDraft(
          fs,
          result,
          draftRepository?.commits ?? [],
          repository.sources.files,
        );
        const filename = await writeWorkspaceDraft(roots.workspaceRoot, values.draft, draft.batch);
        const summary = { draft: filename, ...draft.summary };
        return {
          exitCode:
            summary.issues.length ||
            summary.inspectionErrors.length ||
            summary.unassignedImports.length
              ? 1
              : 0,
          stdout:
            (values.json || globals.json
              ? JSON.stringify(summary)
              : `draft-file ${JSON.stringify(filename)}\n${formatWorkspaceDraft(draft.summary)}`) +
            "\n",
          stderr: "",
        };
      }
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
    await opened(captureFs);
    const captureNodes = () =>
      captureNativeNodeEdits(captureFs).then((result) => {
        fs.invalidNodeEdits = captureFs.invalidNodeEdits;
        return result;
      });
    if (sub === "brief") {
      const brief = await withDocumentHeaderCache(roots.systemRoot, async () =>
        makeContextBrief(
          await inspectCurrentContext(fs, {
            roleId: values.role,
            nodes: captureNodes(),
          }),
          { roleId: values.role },
        ),
      );
      return {
        exitCode: 0,
        stdout:
          (values.json || globals.json ? JSON.stringify(brief) : formatContextBrief(brief)) + "\n",
        stderr: "",
      };
    }
    const { invalidNodes: invalidNativeNodes } = await captureNodes();
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
                  `${item.kind === "node-ahead" ? "ahead" : "behind"}  ${item.nodeId}  ${item.path}  ${item.reasons.join("; ")}${"inspectionRead" in item ? `\nFull current inspection: tent node check ${item.nodeId} --json` : ""}`,
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
