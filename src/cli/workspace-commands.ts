import { transactionResult } from "./transaction-result.js";
import { parseArgs } from "node:util";
import type { NodeFs } from "../fs/node-fs.js";
import { cliErrorText, unknownCommandError, type ErrorContext } from "./error-text.js";
import type { NodeCommandResult, NodeCommandOptions } from "./node-commands.js";

const WORKSPACE_COMMANDS = ["export", "check", "scan"];

export const workspaceHelpText = `tent workspace — the whole Workspace at once

  tent workspace check [--json]
  tent workspace scan [--draft <new-file>] [--json]
  tent workspace export --output <new-directory>

check: broken links, invalid or missing materials, missing Markdown sections, and Node files whose disk and Tent history presence differ after valid native edits are collected. Exits 1 when it finds any; JSON still goes to stdout.
scan: drafts a map of the project's parts when the Workspace has no Nodes; --draft saves it for node create --draft. With Nodes, it checks the map's coverage and boundaries.
export: copies the context graph and its SQLite history to a new directory.
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
    if (sub === "export" ? !values.output : values.output !== undefined)
      throw new Error(workspaceHelpText);
    const [{ resolveWorkspacePaths }, { NodeFs }, { readWorkspaceSettings }] = await Promise.all([
      import("./workspace-path.js"),
      import("../fs/node-fs.js"),
      import("../core/workspace/workspace-settings.js"),
    ]);
    const roots = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: values.workspace ?? globals.workspace,
    });
    const fs = new NodeFs(roots.systemRoot);
    await opened(fs);
    const { workspaceId } = await readWorkspaceSettings(fs);
    if (!workspaceId)
      throw new Error(
        "Tent workspace identity is missing; explicitly initialize or convert this workspace",
      );
    if (sub === "scan") {
      const { captureNativeNodeEdits } = await import("../core/graph/node-native-capture.js");
      const captured = await captureNativeNodeEdits(fs);
      const { loadNodeCatalog } = await import("../core/graph/node-catalog.js");
      const catalog = captured.catalog ?? (await loadNodeCatalog(fs));
      if (catalog.tree.byPath.size) {
        const { checkWorkspaceModules, formatWorkspaceModules } =
          await import("../core/check/workspace-module-map.js");
        const { readModuleMapRepository } = await import("../fs/workspace-scan.js");
        const result = await checkWorkspaceModules(
          fs,
          roots.workspaceRoot,
          await readModuleMapRepository(roots.workspaceRoot),
        );
        const modules = result.partFacts.map((node) => ({
          nodeId: node.id,
          name: node.name,
          path: `.tent/${node.path}`,
          files: node.files.length,
          children: [] as unknown[],
        }));
        const byPath = new Map(modules.map((node) => [node.path, node]));
        const parts = modules.filter((node) => {
          const paths = node.path.split("/");
          paths.pop();
          while (paths.length > 1) {
            const parent = byPath.get(paths.join("/"));
            if (parent) {
              parent.children.push(node);
              return false;
            }
            paths.pop();
          }
          return true;
        });
        const exitCode =
          result.issues.length || result.inspectionErrors.length || result.unassignedImports.length
            ? 1
            : 0;
        return {
          exitCode,
          stdout:
            values.json || globals.json
              ? JSON.stringify({ ...result, parts }) + "\n"
              : formatWorkspaceModules(result),
          stderr:
            values.json || globals.json
              ? ""
              : result.inspectionErrors.map((error) => `${error.node}: ${error.reason}\n`).join(""),
        };
      }

      const [
        { scanWorkspace, formatWorkspaceScan },
        { readModuleMapRepository, readWorkspaceScanRepository, scanFileKind, writeWorkspaceDraft },
      ] = await Promise.all([
        import("../core/check/workspace-scan.js"),
        import("../fs/workspace-scan.js"),
      ]);
      const draftRepository =
        values.draft !== undefined
          ? await readModuleMapRepository(roots.workspaceRoot, { includeProductManifests: true })
          : undefined;
      const repository =
        draftRepository ?? (await readWorkspaceScanRepository(roots.workspaceRoot));
      const result = await scanWorkspace(fs, roots.workspaceRoot, repository, scanFileKind);
      if (values.draft !== undefined) {
        if (!values.draft.trim()) throw new Error("--draft requires a new file path");
        const { prepareWorkspaceDraft, formatWorkspaceDraft, workspaceDraftExitCode } =
          await import("../core/check/workspace-draft.js");
        const draft = await prepareWorkspaceDraft(
          fs,
          result,
          draftRepository?.commits ?? [],
          repository.sources.files,
        );
        const files = await writeWorkspaceDraft(
          roots.workspaceRoot,
          values.draft,
          draft.batch,
          draft.summary,
        );
        const summary = draft.summary;
        return {
          exitCode: workspaceDraftExitCode(summary),
          stdout: formatWorkspaceDraft(
            summary,
            { workspaceRoot: roots.workspaceRoot, ...files },
            values.json || globals.json,
          ),
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
    const { captureNativeNodeEdits } = await import("../core/graph/node-native-capture.js");
    const captureFs = new NodeFs(roots.systemRoot);
    await opened(captureFs);
    const captureNodes = () =>
      captureFs
        .observationScope(() => captureNativeNodeEdits(captureFs))
        .then((result) => {
          fs.invalidNodeEdits = captureFs.invalidNodeEdits;
          return result;
        });
    if (sub === "check") {
      const [{ checkGraph }, { stat }] = await Promise.all([
        import("../core/check/graph-check.js"),
        import("node:fs/promises"),
      ]);
      return await fs.observationScope(async () => {
        const { invalidNodes: invalidNativeNodes, catalog } = await captureNodes();
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
          catalog?.tree,
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
                  (notice) =>
                    `${notice.path}: ${notice.resource ?? notice.field} — ${notice.reason}`,
                ),
              ].join("\n");
        return {
          exitCode: result.issues.length || result.errors.length ? 1 : 0,
          stdout: output + "\n",
          stderr: "",
        };
      });
    }
    await captureNodes();
    const { exportGraph } = await import("../fs/graph-export.js");
    const result = await exportGraph({ ...roots, workspaceId, env: { fs } }, values.output!);
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
