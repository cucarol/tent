import { workspaceReadPaths, nodeReadMaterials } from "./read-paths.js";
import { transactionResult } from "./transaction-result.js";
import { contextExcerpt, originalContextBytes } from "../core/read/agent-context-page.js";
import { formatCliTime } from "./time-text.js";
import { parseArgs } from "node:util";
import { isNodeId } from "../core/base/id.js";
import { normalizeTagName, NODE_TAG_PRESETS, type NodeTagCount } from "../core/base/tags.js";
import type { NodeFs } from "../fs/node-fs.js";
import { readerFlags } from "./reader-flags.js";
import {
  pageItems,
  itemPageStart,
  pageText,
  formatTextPage,
  uncapturedNotice,
  compactItem,
  compactReadItem,
  incompleteNodeRead,
} from "./reader-page.js";
import { cliErrorText, unknownCommandError, type ErrorContext } from "./error-text.js";
import {
  formatNodeWriteProblems,
  type NodeWriteProblem,
} from "../core/check/node-write-problems.js";
import { isNodeNotePath, nodeNotePath } from "../core/base/paths.js";

// Agent-facing parsing and rendering; document semantics and locking belong to Core.

export type NodeCommandOptions = {
  workspace?: string;
  cwd?: string;
  json?: boolean;
  stdin?: string;
};

export type NodeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type NodeProjection = {
  nodeId: string;
  name: string;
  path: string;
  type?: string;
  tags?: string[];
  text?: string;
  etag?: string;
  status?: string | null;
  children?: NodeProjection[];
  uncaptured?: boolean;
};

export async function runNodeCommand(
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
    const { positionals, flags, tagFilters } = parseFlags(args);
    errorContext.workspace = flags.workspace ?? globals.workspace;
    errorContext.baseEtag = flags["base-etag"];
    errorContext.json = globals.json === true || flags.json === "true";
    if (sub === "link-output") errorContext.outputResource = flags.resource;
    const target = positionals[0];
    if (
      target &&
      [
        "get",
        "link-output",
        "history",
        "relations",
        "append",
        "write",
        "rename",
        "move",
        "archive",
        "delete",
      ].includes(sub)
    )
      errorContext.target = { kind: "node", id: target };
    if (flags.help === "true" || ["help", "--help", "-h"].includes(sub)) {
      return { exitCode: 0, stdout: nodeHelpText(sub) + "\n", stderr: "" };
    }
    if (!Object.prototype.hasOwnProperty.call(NODE_COMMAND_HELP, sub))
      throw unknownCommandError("tent node", sub, Object.keys(NODE_COMMAND_HELP));
    if (flags.context !== undefined && sub !== "get")
      return usage("--context is only valid for node get");
    if (flags.id !== undefined && sub !== "create")
      return usage("--id is only valid for node create");
    if (flags.heading !== undefined && sub !== "append")
      return usage("--heading is only valid for node append");
    if (flags.start !== undefined && sub !== "read-many")
      return usage("--start is only valid for node read-many");
    if (flags["sources-json"] !== undefined && sub !== "create")
      return usage(
        "--sources-json is only valid for node create; write standard fields through --input-json frontmatter",
      );
    if (flags.resource !== undefined && !["create", "search", "link-output"].includes(sub))
      return usage("--resource is only valid for node create, search or link-output");
    if (flags.card !== undefined && sub !== "link-output")
      return usage("--card is only valid for node link-output");
    if (flags.role !== undefined && sub !== "link-output")
      return usage("--role is only valid for node link-output");
    if (flags.name !== undefined && sub !== "link-output")
      return usage("--name is only valid for node link-output");
    if (tagFilters.length && sub !== "list") return usage("--tag is only valid for node list");
    if (flags.body === "-" && flags["sources-json"] === "-")
      return usage("Only one input can read stdin");
    if (flags["version-json"] !== undefined && (sub !== "get" || flags.full === "true"))
      return usage("Historical versions require node get without --full");
    if (flags["input-json"] !== undefined && !["write", "write-many"].includes(sub))
      return usage("--input-json is only valid for node write or write-many");
    if (flags.draft !== undefined && sub !== "write-many")
      return usage("--draft is only valid for node write-many");
    if (flags["read-back"] !== undefined && sub !== "write")
      return usage("--read-back is only valid for node write");
    if (
      flags["input-json"] !== undefined &&
      ["body", "base-etag", "read-back"].some((key) => flags[key] !== undefined)
    ) {
      return usage("--input-json supplies the entire write; do not combine it with write fields");
    }
    const json = globals.json === true || flags.json === "true";
    const { resolveWorkspacePaths } = await import("./workspace-path.js");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: flags.workspace ?? globals.workspace,
    });
    errorContext.workspaceRoot = workspaceRoot;
    const collectsNativeEdits =
      !["get", "read-many", "list", "search", "relations", "history"].includes(sub) &&
      sub !== "tags";
    const { NodeFs, SystemClock } = await import("../fs/node-fs.js");
    const { readWorkspaceSettings } = await import("../core/workspace/workspace-settings.js");
    const fs = new NodeFs(systemRoot, "cli");
    await opened(fs);
    const { workspaceId } = await readWorkspaceSettings(fs);
    if (!workspaceId)
      throw new Error(
        "Tent workspace identity is missing; explicitly initialize or convert this workspace",
      );
    const invalidNativeNodes = collectsNativeEdits
      ? (await (await import("../core/graph/node-native-capture.js")).captureNativeNodeEdits(fs))
          .invalidNodes
      : [];
    if (sub === "check" && invalidNativeNodes.some((node) => node.nodeId === target))
      throw new Error(invalidNativeNodes.find((node) => node.nodeId === target)!.reason);
    // Start after native capture: receipts describe this command's writes only.
    const writtenNodePaths = new Set<string>();
    const writeFile = fs.writeFile.bind(fs);
    fs.writeFile = async (file, content) => {
      await writeFile(file, content);
      if (isNodeNotePath(file)) writtenNodePaths.add(file);
    };
    const writeBinary = fs.writeBinary.bind(fs);
    fs.writeBinary = async (file, content) => {
      await writeBinary(file, content);
      if (isNodeNotePath(file)) writtenNodePaths.add(file);
    };
    let inspectedProblems: Promise<NodeWriteProblem[]> | undefined;
    const mutationProblems = () =>
      (inspectedProblems ??= import("../fs/node-write-problems.js").then(
        ({ checkNodeWriteProblems }) =>
          checkNodeWriteProblems(fs, workspaceRoot, [...writtenNodePaths]),
      ));
    const env = { fs, clock: new SystemClock(), tentName: workspaceRoot, tentRoot: systemRoot };
    const mutationPrint = async <T>(result: T, json: boolean, format: (value: T) => string) => {
      const readable = workspaceReadPaths(result, workspaceRoot);
      const warnings = (readable as { warnings?: string[] }).warnings ?? [];
      const problems = await mutationProblems();
      return print({ ...readable, workspaceRoot, problems }, json, () =>
        [
          format(readable),
          ...warnings,
          formatNodeWriteProblems(problems),
          `Workspace: ${workspaceRoot}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    };

    switch (sub) {
      case "link-output": {
        const { linkNodeOutput } = await import("../core/graph/node-output.js");
        const { linkOutputResource, workspaceMaterialFields } = await import("./material-input.js");
        const target = oneTarget(positionals, nodeHelpText(sub));
        if (typeof target !== "string") return target;
        const allowed = ["json", "workspace", "resource", "name", "card", "role", "tags"];
        if (Object.keys(flags).some((key) => !allowed.includes(key)) || !flags.resource)
          return usage(nodeHelpText(sub));
        const material = await workspaceMaterialFields(
          { resource: flags.resource },
          "index.md",
          workspaceRoot,
        );
        const result = await linkNodeOutput(fs, nodeRef(target), {
          resource: linkOutputResource(material.resource as string),
          label: flags.resource,
          name: flags.name,
          cardId: flags.card,
          roleId: flags.role,
          tags: parseCsv(flags.tags).map(normalizeTagName),
        });
        return await mutationPrint(
          result,
          json,
          (value) =>
            `Created ${value.nodeId}  ${value.path}  ${value.etag}${value.cardId ? `\nCard: ${value.cardId}` : ""}`,
        );
      }
      case "write-many": {
        const path = await import("node:path");
        const { openNodeDraft } = await import("../fs/node-draft-consumption.js");
        const { writeNodesDraft } = await import("../core/write/node-write-draft.js");
        const { writeNodesBatch, nodeWriteBatchInputSchema, validateBatchItemName } =
          await import("../core/write/node-write-batch.js");
        const { workspaceMaterialFields } = await import("./material-input.js");
        const { readNodeForEdit } = await import("../core/read/node-query.js");
        if (
          positionals.length ||
          (flags["input-json"] === undefined) === (flags.draft === undefined)
        )
          return usage(nodeHelpText("write-many"));
        if (
          Object.keys(flags).some(
            (key) => !["input-json", "draft", "json", "workspace"].includes(key),
          )
        )
          return usage(nodeHelpText("write-many"));
        if (flags.draft !== undefined && !flags.draft.trim())
          return usage("--draft requires a file path");
        const draft =
          flags.draft === undefined
            ? undefined
            : await openNodeDraft(path.resolve(workspaceRoot, flags.draft), systemRoot);
        const supplied = draft
          ? draft.input
          : JSON.parse(
              flags["input-json"] === "-"
                ? (globals.stdin ?? (await readStdin()))
                : flags["input-json"],
            );
        const prepareInput = async (input: ReturnType<typeof nodeWriteBatchInputSchema.parse>) => {
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
          for (const item of input.items) {
            if (item.op === "create")
              Object.assign(
                item,
                await workspaceMaterialFields(
                  item,
                  nodeNotePath(await locate(`@${item.ref}`)),
                  workspaceRoot,
                ),
              );
            else if (item.frontmatter !== undefined) {
              const previous = await readNodeForEdit(fs, item.nodeId);
              item.frontmatter = await workspaceMaterialFields(
                item.frontmatter,
                nodeNotePath(previous.path),
                workspaceRoot,
                previous.frontmatter,
              );
            }
          }
          return input;
        };
        const result = draft
          ? await writeNodesDraft(env, supplied, draft.store, prepareInput)
          : await writeNodesBatch(
              env,
              await prepareInput(nodeWriteBatchInputSchema.parse(supplied)),
            );
        return await mutationPrint(result, json, (value) =>
          value.results.map((item) => `${item.nodeId}  ${item.path}  ${item.etag}`).join("\n"),
        );
      }
      case "history": {
        const target = oneTarget(
          positionals,
          "tent node history <nodeId> [--limit <n>] [--cursor <cursor>] [--json]",
        );
        if (typeof target !== "string") return target;
        const nodeId = nodeRef(target);
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
      case "list": {
        const { readFullNodeTree, listNodes } = await import("../core/read/node-query.js");
        const { isNodeType } = await import("../core/base/node-type.js");
        if (positionals.length > 0) return usage("tent node list [--full] [--json]");
        if (flags.type !== undefined && !isNodeType(flags.type))
          return usage("--type must be goal, prompt or output.");
        const filters = {
          ...(flags.type !== undefined ? { type: flags.type } : {}),
          ...(tagFilters.length ? { tags: tagFilters } : {}),
        };
        if (flags.full === "true") {
          if (Object.keys(readerFlags(flags)).length || Object.keys(filters).length)
            return usage("--full cannot be combined with reader filters or paging.");
          const nodes = workspaceReadPaths(
            (await readFullNodeTree(fs, { uncaptured: true })) as NodeProjection[],
            workspaceRoot,
          );
          return print({ source: { kind: "live" }, workspaceId, nodes }, json, () =>
            formatTree(nodes),
          );
        }
        const result = pageItems(
          workspaceReadPaths(
            await listNodes(
              fs,
              workspaceId,
              { ...coreReaderFlags(flags), ...filters },
              { uncaptured: true },
            ),
            workspaceRoot,
          ),
          "node.list",
          { limit: numberFlag(flags, "limit"), cursor: flags.cursor },
        );
        return print(workspaceReadPaths(result, workspaceRoot), json, formatReader);
      }
      case "get": {
        const { readNode, readNodeForEdit } = await import("../core/read/node-query.js");
        const { readerReadSchema } = await import("../core/graph/context-reader.js");
        return await fs.observationScope(async () => {
          const target = oneTarget(positionals, "tent node get <nodeId> [--full] [--json]");
          if (typeof target !== "string") return target;
          const ref = nodeRef(target);
          let assemble = flags.full !== "true" && flags.view !== "raw" && !flags.cursor;
          const withContext = async <T>(value: T) => {
            if (flags.context !== "true" || flags["version-json"] || flags.cursor) return value;
            const { goalContextText } = await import("./goal-context.js");
            const { retainedDocumentFs } = await import("../core/graph/retained-read.js");
            return { ...value, context: await goalContextText(await retainedDocumentFs(fs), ref) };
          };
          if (flags.full === "true") {
            const { view, ...filters } = readerFlags(flags);
            if (
              Object.keys(filters).length ||
              (view !== undefined && view !== "body" && view !== "raw")
            )
              return usage("--full cannot be combined with reader filters or paging.");
            const edit = await readNodeForEdit(fs, ref, { uncaptured: true });
            return print(
              await withContext({
                nodeId: edit.nodeId,
                text: view === "raw" ? edit.raw : edit.body,
                etag: edit.etag,
                materials: nodeReadMaterials(edit.frontmatter, edit.path, workspaceRoot),
                ...(edit.uncaptured ? { uncaptured: true } : {}),
              }),
              json,
              formatNodeRead,
            );
          }
          const { nodeId, ...options } = readerReadSchema.parse({
            nodeId: ref,
            ...coreReaderFlags(flags),
          });
          assemble &&= !options.range || options.range.start === 0;
          const { node } = await readNode(
            fs,
            workspaceId,
            { nodeId, ...options },
            { uncaptured: true },
          );
          const output =
            node.view === "summary"
              ? workspaceReadPaths(compactItem(node), workspaceRoot)
              : (() => {
                  const paged = pageText(
                    { ...node, materials: nodeReadMaterials(node, node.path, workspaceRoot) },
                    `node.get:${nodeId}`,
                    {
                      cursor: flags.cursor,
                      maxBytes: assemble
                        ? originalContextBytes - 1024 - (flags.context === "true" ? 1024 : 0)
                        : 16 * 1024 - 1280,
                      ...(assemble
                        ? {
                            pageEnd: node.range.start + contextExcerpt(node.text, 1600).text.length,
                          }
                        : {}),
                    },
                  );
                  return {
                    nodeId: paged.nodeId,
                    text: paged.text,
                    etag: paged.etag,
                    materials: paged.materials,
                    ...(!paged.materials ? { materialsOmitted: true } : {}),
                    ...("uncaptured" in paged && paged.uncaptured ? { uncaptured: true } : {}),
                    ...(paged.partial
                      ? {
                          view: paged.view,
                          range: paged.range,
                          viewLength: paged.viewLength,
                          partial: true,
                          page: paged.page,
                        }
                      : {}),
                  };
                })();
          const value = await withContext(output);
          if (!assemble) return print(value, json, formatNodeRead);
          const { agentContextOutput } = await import("./agent-context.js");
          return agentContextOutput(
            fs,
            workspaceRoot,
            {
              kind: "node",
              nodeId: ref,
              ...(options.version ? { version: options.version } : {}),
            },
            value,
            json,
            formatNodeRead,
          );
        });
      }
      case "read-many": {
        const { readerBatchSchema } = await import("../core/read/reader-batch.js");
        const { prepareNodeBatch } = await import("../core/write/node-batch.js");
        if (flags.full === "true") return usage("read-many uses paged output");
        const input = readerBatchSchema.parse({ nodeIds: positionals, view: flags.view });
        const start = numberFlag(flags, "start") ?? 0;
        if (!Number.isSafeInteger(start) || start < 0 || start > input.nodeIds.length)
          return usage("Invalid --start for read-many");
        if (start === input.nodeIds.length)
          return print({ workspaceId, items: [], page: { hasMore: false } }, json, formatReader);
        const prepared = await prepareNodeBatch(fs, workspaceId, { uncaptured: true });
        const make = (items: unknown[], next: number) => ({
          workspaceId,
          source: prepared.source,
          items,
          page: {
            hasMore: next < input.nodeIds.length,
            ...(next < input.nodeIds.length ? { nextIndex: next } : {}),
          },
        });
        const items: unknown[] = [];
        for (const nodeId of input.nodeIds.slice(start, start + 20)) {
          const entry = await prepared.read(nodeId, input.view);
          const item = workspaceReadPaths(entry.item, workspaceRoot);
          const next = start + items.length + 1;
          const candidate = pageText(item, `node.get:${item.nodeId}`, { maxBytes: 10 * 1024 });
          if (Buffer.byteLength(JSON.stringify(make([...items, candidate], next))) > 16 * 1024 - 1)
            break;
          items.push(candidate);
        }
        if (!items.length)
          throw new Error("First Node exceeds CLI batch metadata budget; use node get");
        const result = make(items, start + items.length);
        return print(workspaceReadPaths(result, workspaceRoot), json, formatReader);
      }
      case "search": {
        const { searchNodes, nodeResourceSearchSchema } =
          await import("../core/read/node-query.js");
        const { workspaceMaterialFields } = await import("./material-input.js");
        return await fs.observationScope(async () => {
          if (positionals.length || flags["include-archived"] !== undefined)
            return usage("tent node search --resource <address> [--json]");
          const input = nodeResourceSearchSchema.parse({
            ...coreReaderFlags(flags),
            ...(flags.resource === undefined
              ? {}
              : await workspaceMaterialFields(
                  { resource: flags.resource },
                  "index.md",
                  workspaceRoot,
                )),
          });
          const result = pageItems(
            workspaceReadPaths(
              await searchNodes(fs, workspaceId, workspaceRoot, input, { uncaptured: true }),
              workspaceRoot,
            ),
            "node.search",
            {
              limit: numberFlag(flags, "limit"),
              cursor: flags.cursor,
              ...(!flags.cursor ? { maxBytes: originalContextBytes / 2 } : {}),
            },
          );
          const output = workspaceReadPaths(result, workspaceRoot);
          if (flags.cursor || !flags.resource) return print(output, json, formatReader);
          const { agentContextOutput } = await import("./agent-context.js");
          return agentContextOutput(
            fs,
            workspaceRoot,
            { kind: "resource", resource: input.resource! },
            output,
            json,
            formatReader,
          );
        });
      }
      case "relations": {
        const { relatedNodes } = await import("../core/read/node-query.js");
        const { readerRelationsSchema } = await import("../core/graph/context-reader.js");
        const { retainedDocumentFs } = await import("../core/graph/retained-read.js");
        const target = oneTarget(
          positionals,
          `tent node ${sub} <nodeId> [--direction parent|children|outgoing|incoming] [--json]`,
        );
        if (typeof target !== "string") return target;
        const options = coreReaderFlags(flags);
        const input = readerRelationsSchema.parse({
          ...options,
          nodeId: target === "root" ? null : nodeRef(target),
        });
        const result = pageItems(
          workspaceReadPaths(
            await relatedNodes(await retainedDocumentFs(fs), workspaceId, input),
            workspaceRoot,
          ),
          `node.${sub}`,
          {
            limit: numberFlag(flags, "limit"),
            cursor: flags.cursor,
          },
        );
        return print(workspaceReadPaths(result, workspaceRoot), json, (value) =>
          formatRelations(value, input.direction),
        );
      }
      case "create": {
        const { materialFields } = await import("../core/base/material.js");
        const { workspaceMaterialFields } = await import("./material-input.js");
        const { validateNodeName } = await import("../core/store/scaffold.js");
        const { createNode } = await import("../core/graph/ops.js");
        const { readNode } = await import("../core/read/node-query.js");
        const { nodeMaterialWarnings } = await import("../core/graph/node-material-warnings.js");
        const materials = materialFields({
          resource: flags.resource,
          sources:
            flags["sources-json"] === undefined
              ? undefined
              : JSON.parse(
                  flags["sources-json"] === "-"
                    ? (globals.stdin ?? (await readStdin()))
                    : flags["sources-json"],
                ),
        });
        const name = oneTarget(
          positionals,
          "tent node create <name> --type <type> [--parent <nodeId|root>] [--body <text>|-] [--resource <address>] [--sources-json <JSON>|-] [--tags a,b] [--json]",
        );
        if (typeof name !== "string") return name;
        const type = flagValue(flags, "type");
        if (type === undefined) {
          return usage("tent node create requires --type <type>");
        }
        let body = flagValue(flags, "body");
        if (body === "-") body = globals.stdin ?? (await readStdin());
        const parentPath =
          !flags.parent || flags.parent === "root"
            ? ""
            : await selectedPath(fs, nodeRef(flags.parent));
        const tags = parseCsv(flags.tags).map(normalizeTagName);
        const normalizedMaterials = await workspaceMaterialFields(
          materials,
          nodeNotePath(
            parentPath
              ? `${parentPath}/${validateNodeName(name, parentPath)}`
              : validateNodeName(name),
          ),
          workspaceRoot,
        );
        const created = await createNode(env, {
          id: flags.id,
          name,
          type,
          parentPath,
          ...(body !== undefined
            ? { body: body && !body.endsWith("\n") ? body + "\n" : body }
            : {}),
          ...normalizedMaterials,
          ...(tags.length > 0 ? { tags } : {}),
        });
        const result = workspaceReadPaths(
          await readNode(fs, workspaceId, { nodeId: created, capture: true }),
          workspaceRoot,
        );
        const warnings = await nodeMaterialWarnings(
          fs,
          { id: created, type, ...normalizedMaterials },
          nodeNotePath(parentPath ? `${parentPath}/${name}` : name),
        );
        const problems = await mutationProblems();
        const receipt = { ...result, ...(warnings.length ? { warnings } : {}) };
        const output = {
          ...receipt,
          node:
            "text" in result.node
              ? mutationTextPage(
                  result.node,
                  `node.get:${created}`,
                  16 * 1024 -
                    1 -
                    Buffer.byteLength(
                      JSON.stringify({ ...receipt, workspaceRoot, problems, node: null }),
                    ) +
                    4,
                )
              : compactItem(result.node),
        };
        return await mutationPrint(output, json, (value) => `Created ${formatNode(value)}`);
      }
      case "append": {
        const { appendNodeBody } = await import("../core/write/node-lightwrite.js");
        const target = oneTarget(positionals, nodeHelpText(sub));
        if (typeof target !== "string") return target;
        const allowed = ["json", "workspace", "heading", "body"];
        if (Object.keys(flags).some((key) => !allowed.includes(key)) || flags.body === undefined)
          return usage(nodeHelpText(sub));
        const nodeId = nodeRef(target);
        const body = flags.body === "-" ? (globals.stdin ?? (await readStdin())) : flags.body;
        const saved = await appendNodeBody(fs, nodeId, {
          body,
          heading: flags.heading,
        });
        const result = {
          workspaceId,
          nodeId,
          path: saved.path,
          etag: saved.etag,
          changed: saved.changed,
          ...(saved.version ? { version: saved.version } : {}),
          ...(saved.warnings ? { warnings: saved.warnings } : {}),
        };
        return await mutationPrint(result, json, () => `Updated ${nodeId}  ${saved.etag}`);
      }
      case "write": {
        const { nodeWriteInputSchema } = await import("../core/write/node-write.js");
        const { writeNodeDocument } = await import("../core/graph/node-document-write.js");
        const { readNodeForEdit } = await import("../core/read/node-query.js");
        const { workspaceMaterialFields } = await import("./material-input.js");
        const { ContextReader } = await import("../core/graph/context-reader.js");
        const { documentLifecycle } = await import("../core/base/document-status.js");
        const { parseFrontmatter } = await import("../core/base/frontmatter.js");
        const target = oneTarget(
          positionals,
          "tent node write <nodeId> --input-json <JSON>|- | --body <text>|- --base-etag <etag> [--read-back] [--json]",
        );
        if (typeof target !== "string") return target;
        let body = flagValue(flags, "body");
        const supplied = flags["input-json"];
        if (
          supplied === undefined &&
          (body === undefined || !flagValue(flags, "base-etag")?.trim())
        ) {
          if (!flagValue(flags, "base-etag")?.trim())
            throw new Error("tent node write needs --base-etag from a complete read.");
          return usage(
            "tent node write <nodeId> --body <text>|- --base-etag <etag> [--read-back] [--json]",
          );
        }
        if (body === "-") body = globals.stdin ?? (await readStdin());
        const writeInput =
          supplied !== undefined
            ? JSON.parse(supplied === "-" ? (globals.stdin ?? (await readStdin())) : supplied)
            : {
                body,
                baseEtag: flagValue(flags, "base-etag"),
                ...(flags["read-back"] === "true" ? { readBack: true } : {}),
              };
        const input = nodeWriteInputSchema.parse(writeInput);
        errorContext.baseEtag = input.baseEtag;
        const ref = nodeRef(target);
        const previous =
          input.frontmatter === undefined ? undefined : await readNodeForEdit(fs, ref);
        const frontmatter = previous
          ? await workspaceMaterialFields(
              input.frontmatter!,
              nodeNotePath(previous.path),
              workspaceRoot,
              previous.frontmatter,
            )
          : {};
        const saved = await writeNodeDocument(fs, ref, {
          body: input.body,
          frontmatter,
          baseEtag: input.baseEtag,
        });
        const readBackCore = new ContextReader(
          { kind: "live", workspaceId },
          [
            {
              nodeId: ref,
              name: saved.name,
              path: saved.path,
              raw: saved.raw,
              etag: saved.etag,
              status: documentLifecycle(parseFrontmatter(saved.raw).data).status,
              invalid: false,
              parentNodeId: null,
              childNodeIds: [],
            },
          ],
          [ref],
        ).read({ nodeId: ref });
        const savedResult = workspaceReadPaths(
          {
            workspaceId,
            workspaceRoot,
            nodeId: ref,
            path: saved.path,
            etag: saved.etag,
            written: "node-document",
            changed: saved.changed,
            ...(saved.version ? { version: saved.version } : {}),
            ...(saved.warnings ? { warnings: saved.warnings } : {}),
          },
          workspaceRoot,
        );
        const problems = await mutationProblems();
        const readBack =
          input.readBack && "text" in readBackCore
            ? mutationTextPage(
                workspaceReadPaths(readBackCore, workspaceRoot),
                `node.get:${ref}`,
                16 * 1024 -
                  1 -
                  Buffer.byteLength(
                    JSON.stringify({
                      ...incompleteNodeRead(savedResult),
                      problems,
                      readBack: null,
                    }),
                  ) +
                  4,
              )
            : undefined;
        const result = { ...savedResult, ...(readBack ? { readBack } : {}) };
        const output = (readBack ? readBack.partial : input.body === undefined)
          ? incompleteNodeRead(result)
          : result;
        return await mutationPrint(output, json, (value) => {
          const { warnings: _warnings, ...readback } = value;
          return input.readBack ? JSON.stringify(readback, null, 2) : `Updated ${ref}`;
        });
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
        const expectedPath = await selectedPath(fs, target);
        const parent = flags.parent;
        const newParentId = !parent || parent === "root" ? null : parent;
        if (newParentId && !isNodeId(newParentId)) {
          return usage("tent node move --parent must be root or a stable node- id");
        }
        const result = await moveNode(env, target, newParentId, { mode: "inside" }, expectedPath);
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
      case "tags": {
        const { listNodeTags } = await import("../core/read/node-query.js");
        if (
          positionals.length ||
          Object.keys(flags).some((key) => !["json", "workspace", "include-archived"].includes(key))
        )
          return usage(nodeHelpText("tags"));
        const result = await listNodeTags(fs, workspaceId, {
          includeArchived: flags["include-archived"] === "true",
        });
        return print(result, json, formatTags);
      }
      default:
        return usage(nodeHelpText());
    }
  } catch (error) {
    const inputJson = args.some((arg) => arg === "--input-json" || arg.startsWith("--input-json="));
    const { NodeWriteError } = await import("../core/graph/node-document-write.js");
    const { NodeSectionError } = await import("../core/base/markdown-section.js");
    const { NodeLifecycleError } = await import("../core/graph/node-lifecycle.js");
    const { NodeBatchWriteError } = await import("../core/write/node-write-batch.js");
    const details =
      error instanceof NodeWriteError ||
      error instanceof NodeSectionError ||
      error instanceof NodeLifecycleError ||
      error instanceof NodeBatchWriteError
        ? incompleteNodeRead(error.details)
        : undefined;
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        cliErrorText(error, `tent node ${sub}${inputJson ? " --input-json" : ""}`, {
          ...errorContext,
          details,
        }) + "\n",
    };
  }
}

const NODE_COMMAND_HELP: Record<string, string[]> = {
  list: [
    "tent node list [--parent <nodeId|root>] [--type goal|prompt|output] [--tag <tag>]... [--limit <n>] [--cursor <cursor>] [--include-archived] [--json]",
    "tent node list --full [--json]",
  ],
  get: [
    "tent node get <nodeId> [--version-json <JSON>] [--view summary|body|raw] [--context] [--range <JSON>] [--expected-etag <etag>] [--cursor <cursor>] [--json]",
    "tent node get <nodeId> --full [--view body|raw] [--json]",
  ],
  "read-many": ["tent node read-many <nodeId> [...] [--view body|raw] [--start <index>] [--json]"],
  history: ["tent node history <nodeId> [--limit <n>] [--cursor <cursor>] [--json]"],
  "link-output": [
    "tent node link-output <goalId> --resource <address> [--name <name>] [--tags a,b] [--role <roleId>] [--card <id>] [--json]",
  ],
  search: ["tent node search --resource <address> [--limit <n>] [--cursor <cursor>] [--json]"],
  relations: [
    "tent node relations <nodeId|root> --direction parent|children|outgoing|incoming [--limit <n>] [--cursor <cursor>] [--include-archived] [--json]",
  ],
  create: [
    "tent node create <name> --type goal|prompt|output [--id node-ID] [--parent <nodeId|root>] [--body <text>|-] [--resource <address>] [--sources-json <JSON>|-] [--tags a,b] [--json]",
  ],
  write: [
    "tent node write <nodeId> [--body <text>|-] --base-etag <etag> [--read-back] [--json]",
    "tent node write <nodeId> --input-json <JSON>|- [--json]",
  ],
  append: ["tent node append <nodeId> --body <text|-> [--heading <title>] [--json]"],
  "write-many": [
    "tent node write-many --input-json <JSON|-> [--json]",
    "tent node write-many --draft <file> [--json]",
  ],
  rename: ["tent node rename <nodeId> <new-name> [--json]"],
  move: ["tent node move <nodeId> --parent <nodeId|root> [--json]"],
  archive: ["tent node archive <nodeId> [--json]"],
  delete: ["tent node delete <nodeId> [--json]"],
  tags: ["tent node tags [--include-archived] [--json]"],
};
export function nodeHelpText(sub?: string): string {
  if (!sub || !Object.prototype.hasOwnProperty.call(NODE_COMMAND_HELP, sub))
    return `tent node — read and record Nodes

Read
  tent node get <id> [--full]                   One Node: its text and materials.
  tent node list [--parent <id>] [--type <type>] [--tag <tag>]...
                                                Children of a Node, or matching Nodes below it.
  tent node search --resource <path>            Nodes whose materials cover a file.
  tent node read-many <id>...                   Several Nodes in one page.
  tent node relations <id> --direction parent|children|outgoing|incoming
  tent node history <id>                        Saved versions.
  tent node tags                                Tags in use, with counts.

Record
  tent node create <name> --type goal|prompt|output [--parent <id>] [--body -]
  tent node append <id> --body - [--heading <title>]
  tent node write <id> --base-etag <etag> --body -
  tent node write-many --input-json -
  tent node link-output <goal-id> --resource <path>

Organize
  tent node rename|move|archive|delete

tent node <command> --help shows all of its options.`;
  const notes: Record<string, string> = {
    list: "Without filters, lists the children of --parent, or the root Nodes. --type and --tag search the whole subtree instead; repeated --tag must all match. --full lists the whole tree; --include-archived adds archived Nodes. Ordinary list entries carry no ETag; read a Node with get before editing them.",
    get: 'Prints the Node\'s text, its declared material paths and its ETag. The first page includes related Agent context; raw, --full and continuation reads do not. A long body comes in pages; continue with --cursor and --expected-etag from the last page. An ETag that starts with read: comes from a partial page and allows only metadata edits; read with --full before replacing content. --view body prints the body only, raw the whole file. --context adds a summary of the goals above it, up to 1 KiB. --range reads part of the body, as {"unit":"utf16","start":0,"end":10}. --version-json reads a saved version, even after the Node was edited or deleted.',
    "read-many":
      "Reads several Nodes into one 16 KiB page. Continue with --start <page.nextIndex> and the same ids. An item cut short continues with node get --expected-etag <item.etag> --cursor <item.page.nextCursor> and the same view.",
    "link-output":
      "Records a file or directory as an output under <goal-id>. Paths start at the Workspace root; end a directory with /. The name defaults to the file or directory name. --card ties the output to the Card it answers; with only --role, Tent picks the Card when that Role has exactly one unfinished Card for this goal.",
    search:
      "Finds Nodes whose materials name or cover a file, most specific first. Search text with your own tools.",
    create:
      "Creates a Node under --parent, or at the root. A goal is what should become true, a prompt holds rules and context to follow, an output records a result at one moment. Tags name form and topic: reuse one from tent node tags or a preset (${presets}). --resource and --sources-json name materials: paths start at the Workspace root, a trailing / marks a directory, and ./ marks a path that does not exist yet; Node ids and URLs also work. --id fixes the new id, so a retry cannot create a duplicate. Names follow Windows file-name rules on every platform.".replace(
        "${presets}",
        NODE_TAG_PRESETS.join(", "),
      ),
    write:
      'Replaces the body. --input-json can also change resource, sources and tags: {"baseEtag":"<etag>","body":"...","frontmatter":{"resource":"src/file.ts"},"readBack":true}; omitted fields stay as they are. Replacing content needs the ETag from a complete live read; a read: ETag allows metadata-only edits. --read-back prints the saved bytes in a bounded page; continue partial results with node get using the returned cursor and ETag.',
    append:
      "Adds text without reading the Node first. --heading appends to the unique matching section, or creates a ## section if it is missing.",
    "write-many":
      'Saves a batch in one commit; if any item fails, nothing is saved. {"items":[{"op":"create","ref":"rules","name":"Rules","type":"prompt","body":"..."},{"op":"update","nodeId":"node-abc123","baseEtag":"<etag>","body":"..."}]}. A create\'s parent is an existing id or @ref; @ref also works in links and material paths, even for items later in the batch. New resource and sources paths start at the Workspace root; raw updates use stored document-relative paths. Updates need ETags from complete reads. Results list nodeId, path and etag in input order.',
    tags: "Lists the tags in use with their counts and marks the presets. Tags only help find Nodes; they change no behavior.",
    archive: "Marks the Node and everything under it archived, in one commit.",
  };
  return [
    ...NODE_COMMAND_HELP[sub],
    ...(notes[sub] ? ["", notes[sub]] : []),
    "",
    "--workspace <path> picks the Workspace; --json prints JSON. Options also take --key=value, and -- ends them.",
    ...(["create", "write", "append"].includes(sub) ? ["--body - reads stdin."] : []),
    ...(["create", "link-output", "search", "write", "write-many"].includes(sub)
      ? [
          "In Git Bash, run commands whose arguments start with / (such as /docs/x.md) with MSYS_NO_PATHCONV=1.",
        ]
      : []),
  ].join("\n");
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

function flagValue(flags: Record<string, string>, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : undefined;
}

function parseCsv(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function parseFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string>;
  tagFilters: string[];
} {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      tag: { type: "string", multiple: true },
      ...Object.fromEntries(
        ["json", "full", "context", "include-archived", "read-back"].map((name) => [
          name,
          { type: "boolean" as const },
        ]),
      ),
      ...Object.fromEntries(
        [
          "workspace",
          "id",
          "parent",
          "limit",
          "cursor",
          "view",
          "range",
          "start",
          "expected-etag",
          "version-json",
          "resource",
          "name",
          "card",
          "role",
          "direction",
          "type",
          "body",
          "heading",
          "sources-json",
          "tags",
          "base-etag",
          "input-json",
          "draft",
        ].map((name) => [name, { type: "string" as const }]),
      ),
    },
  });
  const { tag, ...single } = values;
  const flags = Object.fromEntries(
    Object.entries(single).map(([name, value]) => [name, String(value)]),
  );
  return { positionals, flags, tagFilters: (tag ?? []).map(normalizeTagName) };
}

function formatTags(value: unknown): string {
  const { tags, presets } = value as { tags: NodeTagCount[]; presets: string[] };
  const width = String(tags[0]?.count ?? 0).length;
  return [
    ...(tags.length
      ? tags.map(
          (item) =>
            `${String(item.count).padStart(width)}  ${item.tag}${item.preset ? "  (preset)" : ""}`,
        )
      : ["No tags yet."]),
    `Presets: ${presets.join(", ")}`,
  ].join("\n");
}

function numberFlag(flags: Record<string, string>, key: string) {
  return flags[key] === undefined ? undefined : Number(flags[key]);
}

function coreReaderFlags(flags: Record<string, string>) {
  const { cursor: _cursor, limit: _limit, ...core } = readerFlags(flags);
  return core;
}

function formatNodeRead(value: unknown): string {
  return formatWithContext(value, (content) => {
    const node = content as {
      nodeId: string;
      etag: string;
      text?: string;
      uncaptured?: boolean;
      materials?: string[];
      materialsOmitted?: boolean;
    };
    return node.text === undefined
      ? (node.uncaptured ? `${uncapturedNotice}\n` : "") + JSON.stringify(content, null, 2)
      : `${node.nodeId}\nETag: ${node.etag}\n${(node.materials ?? []).map((material) => `Material: ${material}\n`).join("")}${node.materialsOmitted ? "Materials omitted; use node get --full to read all declarations.\n" : ""}${formatTextPage(content)}`;
  });
}

function formatReader(value: unknown): string {
  return formatWithContext(value, formatReaderContent);
}

function formatRelations(value: unknown, direction: string): string {
  const result = value as {
    items: Array<Record<string, unknown>>;
    page?: { hasMore: boolean; nextCursor?: string };
  };
  const label = (value: unknown): string => {
    if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
    const ref = value as Record<string, unknown>;
    const identity = ref.nodeId ?? ref.id;
    const name =
      (ref.kind === "role" || ref.kind === "card") && typeof identity === "string"
        ? `.tent/${ref.kind}s/${identity}.md`
        : (ref.path ?? ref.workspacePath ?? ref.name ?? ref.uri ?? ref.resource);
    return [identity, name].filter((part) => typeof part === "string").join("  ");
  };
  return (
    [
      ...result.items.map((item) => {
        if (direction === "parent" || direction === "children")
          return `${direction}  ${label(item)}`;
        return `${String(item.kind ?? "link")}  ${label(direction === "incoming" ? item.from : item.target) || String(item.resource ?? item.raw ?? "")}`;
      }),
      ...(result.page?.hasMore ? [`Next: ${result.page.nextCursor}`] : []),
    ].join("\n") || "(empty)"
  );
}

function formatWithContext(value: unknown, format: (value: unknown) => string): string {
  const context = (value as { context?: string }).context;
  return format(value) + (context ? `\n\n${context}` : "");
}

function formatReaderContent(value: unknown): string {
  const result = value as {
    node?: {
      nodeId: string;
      name?: string;
      text?: string;
      view?: string;
      etag?: string;
      uncaptured?: boolean;
    };
    items?: Array<{
      nodeId?: string;
      path?: string;
      name?: string;
      title?: string;
      text?: string;
      uncaptured?: boolean;
      commit?: string;
      operation?: string;
      time?: string;
      objectIds?: string[];
      match?: { kind: string; field: string; index?: number; resource?: string };
      changes?: Array<{ before?: { path: string }; after?: { path: string } }>;
    }>;
    page?: { hasMore: boolean; nextCursor?: string; nextIndex?: number };
  };
  if (result.node) {
    const etag = result.node.etag ? `\nETag: ${result.node.etag}` : "";
    return result.node.text !== undefined
      ? `${[result.node.nodeId, result.node.name, result.node.view].filter(Boolean).join("  ")}${etag}\n${formatTextPage(result.node)}`
      : `${result.node.nodeId}  ${result.node.name ?? ""}${etag}`;
  }
  if (result.items)
    return (
      `${result.items
        .map((item) =>
          item.text !== undefined
            ? `${[item.nodeId, item.name].filter(Boolean).join("  ")}\n${formatTextPage(item)}`
            : [
                item.commit,
                item.time ? formatCliTime(item.time) : undefined,
                item.operation,
                item.nodeId,
                item.path,
                item.name ?? item.title,
                item.match
                  ? `${item.match.kind} ${item.match.field}${item.match.index === undefined ? "" : `[${item.match.index}]`} ${item.match.resource ?? ""}`.trimEnd()
                  : undefined,
                item.uncaptured ? uncapturedNotice : undefined,
                item.objectIds?.join(", "),
                item.changes
                  ?.map((change) => change.after?.path ?? change.before?.path)
                  .filter(Boolean)
                  .join(", "),
              ]
                .filter(Boolean)
                .join("  "),
        )
        .join(
          "\n",
        )}${result.page?.hasMore ? `\nNext: ${result.page.nextCursor ?? result.page.nextIndex}` : ""}` ||
      "(empty)"
    );
  return JSON.stringify(value, null, 2);
}

function print(
  value: unknown,
  json: boolean,
  format: (value: unknown) => string,
): NodeCommandResult {
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(value) + "\n" : format(value).trimEnd() + "\n",
    stderr: "",
  };
}

function mutationTextPage<T extends Parameters<typeof pageText>[0]>(
  value: T,
  operation: string,
  maxBytes: number,
) {
  try {
    return pageText(value, operation, { maxBytes });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "PAGE_TOO_LARGE")
      throw error;
    return { ...incompleteNodeRead(compactReadItem(value)), partial: true };
  }
}

function usage(text: string): NodeCommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: cliErrorText(new Error(text.trimEnd()), "tent node") + "\n",
  };
}

function formatNode(value: unknown): string {
  const node = (value as { node?: NodeProjection }).node;
  if (!node) return JSON.stringify(value);
  return [node.nodeId, node.type, node.path].filter(Boolean).join("  ");
}

function formatTree(nodes: NodeProjection[]): string {
  const lines: string[] = [];
  const visit = (node: NodeProjection, depth: number) => {
    lines.push(
      `${"  ".repeat(depth)}${[node.nodeId, node.type, node.name, node.path].filter(Boolean).join("  ")}`,
    );
    if (node.uncaptured) lines.push(`${"  ".repeat(depth + 1)}${uncapturedNotice}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return lines.length > 0 ? lines.join("\n") : "(no nodes)";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
