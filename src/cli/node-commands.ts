import { parseArgs } from "node:util";
import { transactionResult } from "./transaction-result.js";
import { workspaceReadPaths } from "./read-paths.js";
import { formatCliTime } from "./time-text.js";
import { itemPageStart, pageItems } from "./reader-page.js";
import { cliErrorText, unknownCommandError, type ErrorContext } from "./error-text.js";
import { isNodeId } from "../core/base/id.js";
import { normalizeTagName } from "../core/base/tags.js";
import { isNodeNotePath, nodeNotePath } from "../core/base/paths.js";
import { formatNodeWriteProblems } from "../core/check/node-write-problems.js";
import type { NodeFs } from "../fs/node-fs.js";
export type NodeCommandOptions = {
  workspace?: string;
  cwd?: string;
  json?: boolean;
  stdin?: string;
};
export type NodeCommandResult = { exitCode: number; stdout: string; stderr: string };
const HELP: Record<string, string> = {
  create:
    "tent node create <name> --type goal|prompt|output [--id node-ID] [--parent <nodeId|root>] [--description <text>] [--body <text>|-] [--resource <address>] [--source <address>]... [--tags a,b] [--json]\ntent node create --draft <file> [--json]",
  rename: "tent node rename <nodeId> <new-name> [--json]",
  move: "tent node move <nodeId> --parent <nodeId|root> [--json]",
  archive: "tent node archive <nodeId> [--json]",
  delete: "tent node delete <nodeId> [--json]",
  history:
    "tent node history <nodeId> [--limit <n>] [--cursor <cursor>] [--json]\ntent node history <nodeId> --version <version> [--json]",
};
export function nodeHelpText(sub?: string): string {
  return (
    (sub && HELP[sub] ? HELP[sub] : Object.values(HELP).join("\n")) +
    "\n--workspace <path> picks the Workspace; --json prints JSON."
  );
}
export function runNodeCommand(
  sub: string,
  args: string[],
  globals: NodeCommandOptions = {},
): Promise<NodeCommandResult> {
  return transactionResult((opened) => runNodeCommandOpened(sub, args, globals, opened));
}
async function runNodeCommandOpened(
  sub: string,
  args: string[],
  globals: NodeCommandOptions,
  opened: (fs: NodeFs) => Promise<void>,
): Promise<NodeCommandResult> {
  const errorContext: ErrorContext = { workspace: globals.workspace };
  try {
    const { positionals, flags, sources } = parseFlags(args);
    errorContext.workspace = flags.workspace ?? globals.workspace;
    if (flags.help === "true" || ["help", "--help", "-h"].includes(sub)) return printHelp(sub);
    if (!Object.prototype.hasOwnProperty.call(HELP, sub))
      throw unknownCommandError("tent node", sub, Object.keys(HELP));
    const allowed: Record<string, string[]> = {
      create: ["id", "type", "parent", "body", "description", "resource", "tags", "draft"],
      rename: [],
      move: ["parent"],
      archive: [],
      delete: [],
      history: ["limit", "cursor", "version"],
    };
    if (
      Object.keys(flags).some((key) => !["json", "workspace", ...allowed[sub]!].includes(key)) ||
      (sources.length && sub !== "create")
    )
      return usage(nodeHelpText(sub));
    if (
      flags.draft !== undefined &&
      (positionals.length ||
        sources.length ||
        Object.keys(flags).some((key) => !["draft", "json", "workspace"].includes(key)))
    )
      return usage(nodeHelpText("create"));
    if (flags.draft !== undefined && !flags.draft.trim())
      return usage("--draft requires a file path");
    if (flags.version !== undefined && (flags.limit !== undefined || flags.cursor !== undefined))
      return usage("--version cannot be combined with --limit or --cursor");
    const json = globals.json === true || flags.json === "true";
    const { resolveWorkspacePaths } = await import("./workspace-path.js");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: flags.workspace ?? globals.workspace,
    });
    errorContext.workspaceRoot = workspaceRoot;
    const { NodeFs, SystemClock } = await import("../fs/node-fs.js");
    const fs = new NodeFs(systemRoot, "cli");
    await opened(fs);
    const { readWorkspaceSettings } = await import("../core/workspace/workspace-settings.js");
    const { workspaceId } = await readWorkspaceSettings(fs);
    if (!workspaceId)
      throw new Error(
        "Tent workspace identity is missing; explicitly initialize or convert this workspace",
      );
    await (await import("../core/graph/node-native-capture.js")).captureNativeNodeEdits(fs);
    const writtenNodePaths = new Set<string>();
    const writeFile = fs.writeFile.bind(fs);
    fs.writeFile = async (file, content) => {
      await writeFile(file, content);
      if (isNodeNotePath(file)) writtenNodePaths.add(file);
    };
    const env = { fs, clock: new SystemClock(), tentName: workspaceRoot, tentRoot: systemRoot };
    const mutationPrint = async <T>(result: T, json: boolean, format: (value: T) => string) => {
      const readable = workspaceReadPaths(result, workspaceRoot);
      const { checkNodeWriteProblems } = await import("../fs/node-write-problems.js");
      const problems = await checkNodeWriteProblems(fs, workspaceRoot, [...writtenNodePaths]);
      return print({ ...readable, workspaceRoot, problems }, json, () =>
        [format(readable), formatNodeWriteProblems(problems), `Workspace: ${workspaceRoot}`]
          .filter(Boolean)
          .join("\n"),
      );
    };
    switch (sub) {
      case "history": {
        const target = oneTarget(positionals, nodeHelpText("history"));
        if (typeof target !== "string") return target;
        const nodeId = nodeRef(target);
        if (flags.version !== undefined) {
          const { readNodeVersion } = await import("../core/read/node-version.js");
          const node = await readNodeVersion(fs, nodeId, JSON.parse(flags.version));
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(node) + "\n" : node.text,
            stderr: "",
          };
        }
        const operation = `node.history:${nodeId}`;
        const limit = numberFlag(flags, "limit") ?? 20;
        const start = itemPageStart(flags.cursor, operation, limit);
        const { items, revision, total } = await fs.history!.nodeVersionPage(nodeId, start, limit);
        const result = pageItems({ items, revision }, operation, {
          limit,
          cursor: flags.cursor,
          window: { start, total },
        });
        return print(workspaceReadPaths(result, workspaceRoot), json, formatReader);
      }
      case "create": {
        if (flags.draft !== undefined) {
          const path = await import("node:path");
          const { openNodeDraft } = await import("../fs/node-draft-consumption.js");
          const { writeNodesDraft } = await import("../core/write/node-write-draft.js");
          const { validateBatchItemName } = await import("../core/write/node-write-batch.js");
          const { workspaceMaterialFields } = await import("./material-input.js");
          const draft = await openNodeDraft(path.resolve(workspaceRoot, flags.draft), systemRoot);
          const result = await writeNodesDraft(env, draft.input, draft.store, async (input) => {
            const paths = new Map<string, string>();
            const creates = new Map(
              input.items.filter((item) => item.op === "create").map((item) => [item.ref, item]),
            );
            const visiting = new Set<string>();
            async function locate(ref: string): Promise<string> {
              if (paths.has(ref)) return paths.get(ref)!;
              if (!ref.startsWith("@")) {
                const result = await selectedPath(fs, ref);
                paths.set(ref, result);
                return result;
              }
              const item = creates.get(ref.slice(1));
              if (!item) throw new Error(`Unknown batch ref: ${ref}`);
              if (visiting.has(ref)) throw new Error(`Cyclic batch parent: ${ref}`);
              visiting.add(ref);
              const parent = item.parent ? await locate(item.parent) : "";
              const name = validateBatchItemName(item.ref, item.name, parent);
              const result = parent ? `${parent}/${name}` : name;
              visiting.delete(ref);
              paths.set(ref, result);
              return result;
            }
            for (const item of input.items)
              if (item.op === "create")
                Object.assign(
                  item,
                  await workspaceMaterialFields(
                    item,
                    nodeNotePath(await locate(`@${item.ref}`)),
                    workspaceRoot,
                  ),
                );
            return input;
          });
          return mutationPrint(result, json, (value) =>
            value.results.map((item) => `${item.nodeId}  ${item.path}`).join("\n"),
          );
        }
        const { materialFields } = await import("../core/base/material.js");
        const { workspaceMaterialFields } = await import("./material-input.js");
        const { validateNodeName } = await import("../core/store/scaffold.js");
        const { createNode } = await import("../core/graph/ops.js");
        const { loadNodeCatalog } = await import("../core/graph/node-catalog.js");
        const name = oneTarget(positionals, nodeHelpText(sub));
        if (typeof name !== "string") return name;
        if (!flags.type) return usage("tent node create requires --type <type>");
        let body = flags.body;
        if (body === "-") body = globals.stdin ?? (await readStdin());
        const parentPath =
          !flags.parent || flags.parent === "root"
            ? ""
            : await selectedPath(fs, nodeRef(flags.parent));
        const materials = await workspaceMaterialFields(
          materialFields({
            resource: flags.resource,
            sources: sources.map((resource) => ({ resource })),
          }),
          nodeNotePath(
            parentPath
              ? `${parentPath}/${validateNodeName(name, parentPath)}`
              : validateNodeName(name),
          ),
          workspaceRoot,
        );
        const nodeId = await createNode(env, {
          id: flags.id,
          name,
          type: flags.type,
          parentPath,
          ...(body === undefined ? {} : { body }),
          ...(flags.description === undefined ? {} : { description: flags.description }),
          ...materials,
          ...(flags.tags ? { tags: parseCsv(flags.tags).map(normalizeTagName) } : {}),
        });
        const node = (await loadNodeCatalog(fs)).byId.get(nodeId)!;
        return mutationPrint(
          { node: { nodeId, type: node.type, path: `.tent/${nodeNotePath(node.path)}` } },
          json,
          (value) => `Created ${formatNode(value)}`,
        );
      }
      case "rename": {
        const { renameNode } = await import("../core/graph/rename-ops.js");
        if (positionals.length !== 2) return usage("tent node rename <nodeId> <new-name> [--json]");
        const result = await renameNode(env, nodeRef(positionals[0]), positionals[1]);
        for (const [from, to] of Object.entries(result.pathMap))
          if (from !== to) writtenNodePaths.add(nodeNotePath(to));
        return await mutationPrint(result, json, (value) => `Renamed ${formatNode(value)}`);
      }
      case "move": {
        const { moveNode } = await import("../core/graph/move-ops.js");
        const target = oneTarget(
          positionals,
          "tent node move <nodeId> --parent <nodeId|root> [--json]",
        );
        if (typeof target !== "string" || !isNodeId(target)) {
          return typeof target === "string"
            ? usage("tent node move requires a stable node- id")
            : target;
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "parent")) {
          return usage("tent node move <nodeId> --parent <nodeId|root> [--json]");
        }
        const parent = flags.parent;
        const newParentId = !parent || parent === "root" ? null : parent;
        if (newParentId && !isNodeId(newParentId)) {
          return usage("tent node move --parent must be root or a stable node- id");
        }
        const result = await moveNode(env, target, newParentId, { mode: "inside" });
        for (const [from, to] of Object.entries(result.pathMap ?? {}))
          if (from !== to) writtenNodePaths.add(nodeNotePath(to));
        return await mutationPrint(result, json, () => `Moved ${target}`);
      }
      case "archive": {
        const { archiveNode } = await import("../core/graph/node-lifecycle.js");
        const target = oneTarget(positionals, `tent node ${sub} <nodeId> [--json]`);
        if (typeof target !== "string") return target;
        const result = await archiveNode(env, nodeRef(target));
        return await mutationPrint(result, json, () => `Archived ${target}`);
      }
      case "delete": {
        const { deleteNode } = await import("../core/graph/ops.js");
        const target = oneTarget(positionals, "tent node delete <nodeId> [--json]");
        if (typeof target !== "string") return target;
        const result = await deleteNode(env, nodeRef(target));
        return await mutationPrint(result, json, () => `Deleted ${target}`);
      }
    }
    return usage(nodeHelpText(sub));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: cliErrorText(error, `tent node ${sub}`, errorContext) + "\n",
    };
  }
}
function printHelp(sub: string): NodeCommandResult {
  return { exitCode: 0, stdout: nodeHelpText(sub) + "\n", stderr: "" };
}
function parseFlags(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      source: { type: "string", multiple: true },
      ...Object.fromEntries(
        [
          "workspace",
          "id",
          "type",
          "parent",
          "body",
          "description",
          "resource",
          "tags",
          "limit",
          "cursor",
          "draft",
          "version",
        ].map((key) => [key, { type: "string" as const }]),
      ),
    },
  });
  const { source, ...rest } = values;
  return {
    positionals,
    flags: Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
    sources: source ?? [],
  };
}
function nodeRef(value: string): string {
  if (!isNodeId(value)) throw new Error(`Expected canonical Node id (node-*): ${value}`);
  return value;
}

async function selectedPath(fs: NodeFs, id: string) {
  const { loadNodeCatalog } = await import("../core/graph/node-catalog.js");
  const node = (await loadNodeCatalog(fs)).byId.get(id);
  if (!node) throw new Error(`Node not found: ${id}`);
  return node.path;
}

function oneTarget(positionals: string[], help: string): string | NodeCommandResult {
  return positionals.length === 1 ? positionals[0] : usage(help);
}

function parseCsv(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean) ?? []
  );
}
function numberFlag(flags: Record<string, string>, key: string) {
  return flags[key] === undefined ? undefined : Number(flags[key]);
}
function formatReader(value: unknown) {
  const result = value as {
    items: Record<string, unknown>[];
    page?: { hasMore: boolean; nextCursor?: string };
  };
  return (
    result.items
      .map((item) =>
        [
          item.commit,
          item.time ? formatCliTime(String(item.time)) : undefined,
          item.operation,
          (item.changes as { after?: { path: string }; before?: { path: string } }[] | undefined)
            ?.map((x) => x.after?.path ?? x.before?.path)
            .join(", "),
        ]
          .filter(Boolean)
          .join("  "),
      )
      .join("\n") + (result.page?.hasMore ? `\nNext: ${result.page.nextCursor}` : "")
  );
}
function formatNode(value: unknown) {
  const node = (value as { node?: { nodeId?: string; type?: string; path?: string } }).node;
  return node
    ? [node.nodeId, node.type, node.path].filter(Boolean).join("  ")
    : JSON.stringify(value);
}
function print(
  value: unknown,
  json: boolean,
  format: (value: unknown) => string,
): NodeCommandResult {
  return {
    exitCode: 0,
    stdout: (json ? JSON.stringify(value) : format(value)).trimEnd() + "\n",
    stderr: "",
  };
}
function usage(text: string): NodeCommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: cliErrorText(new Error(text.trimEnd()), "tent node") + "\n",
  };
}
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}
