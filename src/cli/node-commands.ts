import { parseArgs } from "node:util";
import { linkOutputResource, workspaceMaterialFields } from "./material-input.js";
import { validateNodeName } from "../core/scaffold.js";
import { nodeActorSchema } from "../core/node-provenance.js";
import { isNodeId } from "../core/id.js";
// Agent-facing parsing and rendering; document semantics and locking belong to Core.

import { materialFields } from "../core/material.js";
import { normalizeOptionalNodeType, isNodeType } from "../core/node-type.js";
import { normalizeTagName, NODE_TAG_PRESETS, type NodeTagCount } from "../core/tags.js";
import { nodeWriteInputSchema } from "../core/node-write.js";
import {
  writeNodesBatch,
  nodeWriteBatchInputSchema,
  NodeBatchWriteError,
} from "../core/node-write-batch.js";
import { NodeFs, SystemClock } from "../fs/node-fs.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import { readWorkspaceSettings } from "../core/workspace-settings.js";
import {
  readNode,
  readNodeForEdit,
  readFullNodeTree,
  listNodes,
  listNodeTags,
  searchNodes,
  relatedNodes,
} from "../core/node-query.js";
import { prepareNodeBatch } from "../core/node-batch.js";
import { nodeNotePath } from "../core/paths.js";
import { readDocumentDiff } from "../core/document-diff.js";
import {
  createNode,
  renameNode,
  moveNode,
  archiveNode,
  restoreNode,
  deleteNode,
} from "../core/ops.js";
import { writeNodeDocument, NodeWriteError } from "../core/node-document-write.js";
import {
  appendNodeBody,
  readNodeSection,
  writeNodeSection,
  NodeSectionError,
} from "../core/node-lightwrite.js";
import { NodeLifecycleError } from "../core/node-lifecycle.js";
import { ContextReader } from "../core/context-reader.js";
import { documentLifecycle } from "../core/document-status.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { loadNodeCatalog } from "../core/node-catalog.js";
import {
  readerReadSchema,
  readerRelationsSchema,
  readerSearchSchema,
} from "../core/context-reader.js";
import { readerFlags } from "./reader-flags.js";
import { readerBatchSchema } from "../core/reader-batch.js";
import {
  pageItems,
  pageText,
  formatTextPage,
  compactItem,
  incompleteNodeRead,
} from "./reader-page.js";
import { canonicalSha256 } from "../core/canonical-digest.js";
import { nodeReadRevisionEtag } from "../core/node-read-basis.js";
import { inspectNodeSync, confirmNodeSync, linkNodeOutput } from "../core/node-sync.js";
import { goalContextText } from "./goal-context.js";
import { cliErrorText } from "./error-text.js";

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
};

export async function runNodeCommand(
  sub: string,
  args: string[],
  globals: NodeCommandOptions = {},
): Promise<NodeCommandResult> {
  try {
    const { positionals, flags, tagFilters } = parseFlags(args);
    if (flags.help === "true" || ["help", "--help", "-h"].includes(sub)) {
      return { exitCode: 0, stdout: nodeHelpText(sub) + "\n", stderr: "" };
    }
    if (!Object.prototype.hasOwnProperty.call(NODE_COMMAND_HELP, sub)) return usage(nodeHelpText());
    if (flags.heading !== undefined && !["append", "get-section", "write-section"].includes(sub))
      return usage("--heading is only valid for node append, get-section or write-section");
    if (
      flags.by !== undefined &&
      ![
        "create",
        "write",
        "append",
        "write-section",
        "confirm",
        "link-output",
        "type",
        "tags",
      ].includes(sub)
    )
      return usage("--by is only valid for content writes and node confirm");
    if (flags.start !== undefined && sub !== "read-many")
      return usage("--start is only valid for node read-many");
    if (flags["archive-commit"] !== undefined && sub !== "restore")
      return usage("--archive-commit is only valid for node restore");
    if (flags["sources-json"] !== undefined && sub !== "create")
      return usage(
        "--sources-json is only valid for node create; write standard fields through --input-json frontmatter",
      );
    if (flags.resource !== undefined && !["create", "search", "link-output"].includes(sub))
      return usage("--resource is only valid for node create, search or link-output");
    if (flags.confirm !== undefined && sub !== "write")
      return usage("--confirm is only valid for node write");
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
    if (flags["read-back"] !== undefined && sub !== "write")
      return usage("--read-back is only valid for node write");
    if (
      flags["input-json"] !== undefined &&
      ["body", "base-etag", "read-back", "confirm", "by"].some((key) => flags[key] !== undefined)
    ) {
      return usage("--input-json supplies the entire write; do not combine it with write fields");
    }
    const json = globals.json === true || flags.json === "true";
    if (flags.by !== undefined) validateActor(flags.by, "--by");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: flags.workspace ?? globals.workspace,
    });
    const fs = new NodeFs(systemRoot, "cli", sub === "get" ? "inspect" : "record");
    const { workspaceId } = await readWorkspaceSettings(fs);
    if (!workspaceId)
      throw new Error(
        "Tent workspace identity is missing; explicitly initialize or convert this workspace",
      );
    const env = { fs, clock: new SystemClock(), tentName: workspaceRoot, tentRoot: systemRoot };
    const mutationPrint = <T>(result: T, json: boolean, format: (value: T) => string) =>
      print(
        { ...result, workspaceRoot },
        json,
        () => `${format(result)}\nWorkspace: ${workspaceRoot}`,
      );

    switch (sub) {
      case "check": {
        const target = oneTarget(positionals, nodeHelpText("check"));
        if (typeof target !== "string") return target;
        if (Object.keys(flags).some((key) => !["json", "workspace"].includes(key)))
          return usage(nodeHelpText("check"));
        const result = await inspectNodeSync(fs, nodeRef(target));
        return print(result, json, (value) => JSON.stringify(value, null, 2));
      }
      case "link-output": {
        const target = oneTarget(positionals, nodeHelpText(sub));
        if (typeof target !== "string") return target;
        const allowed = ["json", "workspace", "resource", "name", "by", "card", "role", "tags"];
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
          by: flags.by,
          cardId: flags.card,
          roleId: flags.role,
          tags: parseCsv(flags.tags).map(normalizeTagName),
        });
        return mutationPrint(result, json, () =>
          [
            `Created ${result.nodeId}  ${result.path}  ${result.etag}${result.cardId ? `\nCard: ${result.cardId}` : ""}`,
            ...(result.warnings ?? []),
          ].join("\n"),
        );
      }
      case "confirm": {
        const target = oneTarget(positionals, nodeHelpText(sub));
        if (typeof target !== "string") return target;
        const allowed = ["json", "workspace", "base-etag", "by"];
        if (Object.keys(flags).some((key) => !allowed.includes(key)))
          return usage(nodeHelpText(sub));
        if (!flags["base-etag"])
          return usage(
            [
              `node confirm needs --base-etag <etag>: the etag of a complete live read of ${target}.`,
              `Get it with \`tent node get ${target} --json\` (node.etag); a read:<etag> from a partial page is rejected, so use --full for long Nodes.`,
              `Usage: ${NODE_COMMAND_HELP.confirm![0]}`,
            ].join("\n"),
          );
        const nodeId = nodeRef(target);
        const saved = await confirmNodeSync(fs, nodeId, {
          baseEtag: flags["base-etag"],
          by: flags.by,
        });
        const result = {
          nodeId,
          path: saved.path,
          etag: saved.etag,
          changed: saved.changed,
          ...(saved.version ? { version: saved.version } : {}),
        };
        return mutationPrint(
          result,
          json,
          () => `${result.nodeId}  ${result.path}  ${result.etag}`,
        );
      }
      case "write-many": {
        if (positionals.length || flags["input-json"] === undefined)
          return usage(nodeHelpText("write-many"));
        if (Object.keys(flags).some((key) => !["input-json", "json", "workspace"].includes(key)))
          return usage(nodeHelpText("write-many"));
        const supplied = JSON.parse(
          flags["input-json"] === "-"
            ? (globals.stdin ?? (await readStdin()))
            : flags["input-json"],
        );
        if (Array.isArray(supplied?.items))
          for (const item of supplied.items)
            if (item?.by !== undefined) validateActor(item.by, "by");
        const input = nodeWriteBatchInputSchema.parse(supplied);
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
          const name = validateNodeName(item.name, parent);
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
        const result = await writeNodesBatch(env, input);
        return mutationPrint(result, json, () =>
          result.results.map((item) => `${item.nodeId}  ${item.path}  ${item.etag}`).join("\n"),
        );
      }
      case "diff": {
        if (positionals.length || !flags["from-json"] || !flags["to-json"])
          return usage(nodeHelpText("diff"));
        const diff = await readDocumentDiff(fs, {
          from: JSON.parse(flags["from-json"]),
          to: JSON.parse(flags["to-json"]),
        });
        const result = pageText(
          { ...diff, etag: canonicalSha256(diff.text), view: "diff", total: diff.length },
          "node.diff",
          { cursor: flags.cursor },
        );
        return print(result, json, formatTextPage);
      }
      case "history": {
        const target = oneTarget(
          positionals,
          "tent node history <nodeId> [--limit <n>] [--cursor <cursor>] [--json]",
        );
        if (typeof target !== "string") return target;
        const nodeId = nodeRef(target);
        const items = await (
          fs.history as typeof fs.history & { nodeVersions(nodeId: string): Promise<unknown[]> }
        ).nodeVersions(nodeId);
        const result = pageItems(
          { items, revision: canonicalSha256(items) },
          `node.history:${nodeId}`,
          { limit: numberFlag(flags, "limit"), cursor: flags.cursor },
        );
        return print(result, json, formatReader);
      }
      case "list": {
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
          const nodes = (await readFullNodeTree(fs, { capture: true })) as NodeProjection[];
          return print({ source: { kind: "live" }, workspaceId, nodes }, json, () =>
            formatTree(nodes),
          );
        }
        const result = pageItems(
          await listNodes(fs, workspaceId, { ...coreReaderFlags(flags), ...filters }),
          "node.list",
          { limit: numberFlag(flags, "limit"), cursor: flags.cursor },
        );
        return print(result, json, formatReader);
      }
      case "get": {
        const target = oneTarget(positionals, "tent node get <nodeId> [--full] [--json]");
        if (typeof target !== "string") return target;
        const ref = nodeRef(target);
        const withContext = async <T extends { node: { type?: string } }>(value: T) =>
          !flags["version-json"] && !flags.cursor
            ? { ...value, context: await goalContextText(fs, ref) }
            : value;
        if (flags.full === "true") {
          const { view, ...filters } = readerFlags(flags);
          if (
            Object.keys(filters).length ||
            (view !== undefined && view !== "body" && view !== "raw")
          )
            return usage("--full cannot be combined with reader filters or paging.");
          if (view === "raw")
            return print(
              await withContext(
                await readNode(fs, workspaceId, { nodeId: ref, view: "raw", capture: true }),
              ),
              json,
              formatReader,
            );
          const edit = await readNodeForEdit(fs, ref, { capture: true });
          if (edit.frontmatter.id !== undefined && edit.frontmatter.id !== edit.nodeId) {
            throw new Error(`Node editing read returned mismatched Node id for ${ref}.`);
          }
          if (
            edit.frontmatter.type !== undefined &&
            normalizeOptionalNodeType(edit.frontmatter.type) !== edit.type
          ) {
            throw new Error(`Node editing read returned mismatched Node type for ${ref}.`);
          }
          return print(
            await withContext({
              source: { kind: "live" },
              workspaceId,
              node: {
                nodeId: edit.nodeId,
                path: edit.path,
                name: edit.name,
                type: edit.type,
                tags: stringList(edit.frontmatter.tags, "tags"),
                ...materialFields(edit.frontmatter),
                text: edit.body,
                etag: edit.etag,
                ...(edit.version ? { version: edit.version } : {}),
                status: edit.status,
                ...(edit.statusDiagnostic ? { statusDiagnostic: edit.statusDiagnostic } : {}),
                archived: edit.archived,
              },
            }),
            json,
            (value) =>
              formatWithContext(value, (node) => `${formatNode(node)}\nETag: ${edit.etag}`),
          );
        }
        const { nodeId, ...options } = readerReadSchema.parse({
          nodeId: ref,
          ...coreReaderFlags(flags),
        });
        const observed = await readNode(fs, workspaceId, { nodeId, ...options });
        const maxBytes = 16 * 1024 - 256 - (!flags["version-json"] ? 1024 : 0);
        if (observed.node.view !== "summary")
          pageText(observed.node, `node.get:${nodeId}`, {
            cursor: flags.cursor,
            maxBytes,
          });
        const result =
          observed.node.view === "summary"
            ? observed
            : flags["version-json"]
              ? observed
              : await readNode(fs, workspaceId, {
                  nodeId,
                  ...options,
                  expectedEtag: observed.node.etag,
                  capture: true,
                });
        const output =
          result.node.view === "summary"
            ? { ...result, node: compactItem(result.node) }
            : {
                ...result,
                node: pageText(result.node, `node.get:${nodeId}`, {
                  cursor: flags.cursor,
                  maxBytes,
                }),
              };
        return print(await withContext(output), json, formatReader);
      }
      case "read-many": {
        if (flags.full === "true") return usage("read-many uses paged output");
        const input = readerBatchSchema.parse({ nodeIds: positionals, view: flags.view });
        const start = numberFlag(flags, "start") ?? 0;
        if (!Number.isSafeInteger(start) || start < 0 || start > input.nodeIds.length)
          return usage("Invalid --start for read-many");
        if (start === input.nodeIds.length)
          return print({ workspaceId, items: [], page: { hasMore: false } }, json, formatReader);
        const prepared = await prepareNodeBatch(fs, workspaceId);
        const selected: Array<Awaited<ReturnType<typeof prepared.read>>> = [];
        const make = (items: unknown[], next: number) => ({
          workspaceId,
          source: prepared.source,
          items,
          page: {
            hasMore: next < input.nodeIds.length,
            ...(next < input.nodeIds.length ? { nextIndex: next } : {}),
          },
        });
        const planned: unknown[] = [];
        for (const nodeId of input.nodeIds.slice(start, start + 20)) {
          const entry = await prepared.read(nodeId, input.view);
          const item = entry.item;
          const next = start + selected.length + 1;
          const reserved = {
            ...item,
            version: { commit: "f".repeat(64), path: nodeNotePath(entry.document.path) },
          };
          const candidate = pageText(
            { ...reserved, source: { kind: "git", workspaceId, version: reserved.version } },
            `node.get:${item.nodeId}`,
            { maxBytes: 10 * 1024 },
          );
          if (Buffer.byteLength(JSON.stringify(make([...planned, candidate], next))) > 16 * 1024)
            break;
          selected.push(entry);
          planned.push(candidate);
        }
        if (!selected.length)
          throw new Error("First Node exceeds CLI batch metadata budget; use node get");
        const captured = await prepared.capture(selected);
        const items = captured.map((item, index) =>
          pageText(
            {
              ...item,
              source: item.version
                ? { kind: "git", workspaceId, version: item.version }
                : item.source,
            },
            `node.get:${item.nodeId}`,
            {
              pageEnd: (planned[index] as { range: { end: number } }).range.end,
              maxBytes: 10 * 1024,
            },
          ),
        );
        const result = make(items, start + selected.length);
        return print(result, json, formatReader);
      }
      case "search": {
        if (positionals.length > 1)
          return usage("tent node search [query | --resource <address>] [--json]");
        const input = readerSearchSchema.parse({
          ...(positionals[0] !== undefined ? { query: positionals[0] } : {}),
          ...coreReaderFlags(flags),
          ...(flags.resource === undefined
            ? {}
            : await workspaceMaterialFields(
                { resource: flags.resource },
                "index.md",
                workspaceRoot,
              )),
        });
        const result = pageItems(await searchNodes(fs, workspaceId, input), "node.search", {
          limit: numberFlag(flags, "limit"),
          cursor: flags.cursor,
        });
        return print(result, json, formatReader);
      }
      case "relations": {
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
        const result = pageItems(await relatedNodes(fs, workspaceId, input), `node.${sub}`, {
          limit: numberFlag(flags, "limit"),
          cursor: flags.cursor,
        });
        return print(result, json, formatReader);
      }
      case "create": {
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
          name,
          type,
          parentPath,
          ...(body !== undefined
            ? { body: body && !body.endsWith("\n") ? body + "\n" : body }
            : {}),
          ...normalizedMaterials,
          ...(flags.by !== undefined ? { by: flags.by } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        });
        const result = await readNode(fs, workspaceId, { nodeId: created, capture: true });
        const output = {
          ...result,
          node:
            "text" in result.node
              ? pageText(result.node, `node.get:${created}`, {
                  maxBytes:
                    16 * 1024 -
                    Buffer.byteLength(JSON.stringify({ ...result, workspaceRoot, node: null })) +
                    4,
                })
              : compactItem(result.node),
        };
        return mutationPrint(output, json, (value) => `Created ${formatNode(value)}`);
      }
      case "append":
      case "get-section":
      case "write-section": {
        const target = oneTarget(positionals, nodeHelpText(sub));
        if (typeof target !== "string") return target;
        const allowed = [
          "json",
          "workspace",
          "heading",
          ...(sub === "get-section" ? [] : ["body", "by"]),
          ...(sub === "write-section" ? ["base-etag"] : []),
        ];
        if (
          Object.keys(flags).some((key) => !allowed.includes(key)) ||
          (sub !== "append" && flags.heading === undefined) ||
          (sub !== "get-section" && flags.body === undefined) ||
          (sub === "write-section" && !flags["base-etag"])
        )
          return usage(nodeHelpText(sub));
        const nodeId = nodeRef(target);
        if (sub === "get-section") {
          const result = await readNodeSection(fs, nodeId, flags.heading);
          return print(result, json, () => `${nodeId}  ${result.sectionEtag}\n${result.text}`);
        }
        const body = flags.body === "-" ? (globals.stdin ?? (await readStdin())) : flags.body;
        const saved =
          sub === "append"
            ? await appendNodeBody(fs, nodeId, { body, heading: flags.heading, by: flags.by })
            : await writeNodeSection(fs, nodeId, {
                heading: flags.heading,
                baseEtag: flags["base-etag"],
                body,
                by: flags.by,
              });
        const result = {
          workspaceId,
          nodeId,
          path: saved.path,
          etag: saved.etag,
          changed: saved.changed,
          ...(saved.version ? { version: saved.version } : {}),
        };
        return mutationPrint(result, json, () => `Updated ${nodeId}  ${saved.etag}`);
      }
      case "write": {
        const target = oneTarget(
          positionals,
          "tent node write <nodeId> --input-json <JSON>|- | --body <text>|- --base-etag <etag> [--read-back] [--json]",
        );
        if (typeof target !== "string") return target;
        let body = flagValue(flags, "body");
        const supplied = flags["input-json"];
        if (
          supplied === undefined &&
          ((body === undefined && flags.confirm === undefined) ||
            !flagValue(flags, "base-etag")?.trim())
        ) {
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
                ...(flags.confirm === "true" ? { confirm: true } : {}),
                ...(flags.by !== undefined ? { by: flags.by } : {}),
                ...(flags["read-back"] === "true" ? { readBack: true } : {}),
              };
        if (writeInput?.by !== undefined) validateActor(writeInput.by, "by");
        const input = nodeWriteInputSchema.parse(writeInput);
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
          confirm: input.confirm,
          by: input.by,
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
              archived: documentLifecycle(parseFrontmatter(saved.raw).data).status === "deprecated",
              invalid: false,
              parentNodeId: null,
              childNodeIds: [],
            },
          ],
          [ref],
        ).read({ nodeId: ref });
        const savedResult = {
          workspaceId,
          workspaceRoot,
          nodeId: ref,
          path: saved.path,
          etag: saved.etag,
          written: "node-document",
          changed: saved.changed,
          ...(saved.version ? { version: saved.version } : {}),
        };
        const readBack =
          input.readBack && "text" in readBackCore
            ? pageText(readBackCore, `node.get:${ref}`, {
                maxBytes:
                  16 * 1024 -
                  Buffer.byteLength(
                    JSON.stringify({
                      ...incompleteNodeRead(savedResult),
                      readBack: null,
                    }),
                  ) +
                  4,
              })
            : undefined;
        const result = { ...savedResult, ...(readBack ? { readBack } : {}) };
        const output = (readBack ? readBack.partial : input.body === undefined)
          ? incompleteNodeRead(result)
          : result;
        return mutationPrint(output, json, () =>
          input.readBack ? JSON.stringify(output, null, 2) : `Updated ${ref}`,
        );
      }
      case "rename": {
        if (positionals.length !== 2) return usage("tent node rename <nodeId> <new-name> [--json]");
        const result = await renameNode(env, nodeRef(positionals[0]), positionals[1]);
        return mutationPrint(result, json, (value) => `Renamed ${formatNode(value)}`);
      }
      case "move": {
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
        return mutationPrint(result, json, () => `Moved ${target}`);
      }
      case "archive":
      case "restore": {
        const target = oneTarget(positionals, `tent node ${sub} <nodeId> [--json]`);
        if (typeof target !== "string") return target;
        const archiveCommit = flagValue(flags, "archive-commit");
        if (sub === "restore" && !archiveCommit)
          return usage("tent node restore <nodeId> --archive-commit <commit> [--json]");
        const result =
          sub === "archive"
            ? await archiveNode(env, nodeRef(target))
            : await restoreNode(env, nodeRef(target), archiveCommit!);
        return mutationPrint(
          result,
          json,
          () => `${sub === "archive" ? "Archived" : "Restored"} ${target}`,
        );
      }
      case "delete": {
        const target = oneTarget(positionals, "tent node delete <nodeId> [--json]");
        if (typeof target !== "string") return target;
        const result = await deleteNode(env, nodeRef(target));
        return mutationPrint(result, json, () => `Deleted ${target}`);
      }
      case "type": {
        const baseEtag = flagValue(flags, "base-etag");
        if (positionals.length !== 2 || !baseEtag?.trim())
          return usage("tent node type <nodeId> <type> --base-etag <live-etag> [--json]");
        const ref = nodeRef(positionals[0]);
        const saved = await writeNodeDocument(fs, ref, {
          baseEtag,
          frontmatter: { type: positionals[1] },
          by: flags.by,
        });
        const result = { nodeId: ref, etag: saved.etag, version: saved.version };
        return mutationPrint(incompleteNodeRead(result), json, () => `Updated type for ${ref}`);
      }
      case "tags": {
        if (!positionals.length && flags["base-etag"] === undefined) {
          if (
            Object.keys(flags).some(
              (key) => !["json", "workspace", "include-archived"].includes(key),
            )
          )
            return usage(nodeHelpText("tags"));
          const result = await listNodeTags(fs, workspaceId, {
            includeArchived: flags["include-archived"] === "true",
          });
          return print(result, json, formatTags);
        }
        const action = positionals[0];
        const target = positionals[1];
        const baseEtag = flagValue(flags, "base-etag");
        if (!baseEtag?.trim()) return usage("tent node tags requires --base-etag <live-etag>");
        if (!action || !target || !["set", "add", "remove"].includes(action)) {
          return usage(
            "tent node tags set|add|remove <nodeId> <tag[,tag...]> --base-etag <live-etag> [--json]",
          );
        }
        const values = parseCsv(positionals.slice(2).join(",")).map(normalizeTagName);
        if (values.length === 0 && action !== "set") {
          return usage(
            "tent node tags set|add|remove <nodeId> <tag[,tag...]> --base-etag <live-etag> [--json]",
          );
        }
        const ref = nodeRef(target);
        const edit = await readNodeForEdit(fs, ref);
        if (edit.etag !== nodeReadRevisionEtag(baseEtag))
          throw new Error("Node ETag conflict; reread and reconcile before changing tags.");
        const current = Array.isArray(edit.frontmatter.tags)
          ? (edit.frontmatter.tags as string[])
          : [];
        const tags =
          action === "set"
            ? values
            : action === "add"
              ? [...new Set([...current, ...values])]
              : current.filter((tag) => !values.includes(tag));
        const saved = await writeNodeDocument(fs, ref, {
          baseEtag,
          frontmatter: { tags },
          by: flags.by,
        });
        const result = { nodeId: ref, etag: saved.etag, version: saved.version };
        return mutationPrint(incompleteNodeRead(result), json, () => `Updated tags for ${target}`);
      }
      default:
        return usage(nodeHelpText());
    }
  } catch (error) {
    const inputJson = args.some((arg) => arg === "--input-json" || arg.startsWith("--input-json="));
    const message = cliErrorText(error, `tent node ${sub}${inputJson ? " --input-json" : ""}`);
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
      stderr: message + (details ? `\n${JSON.stringify(details)}` : "") + "\n",
    };
  }
}

const NODE_COMMAND_HELP: Record<string, string[]> = {
  list: [
    "tent node list [--parent <nodeId|root>] [--type goal|prompt|output] [--tag <tag>]... [--limit <n>] [--cursor <cursor>] [--include-archived] [--json]",
    "tent node list --full [--json]",
  ],
  get: [
    "tent node get <nodeId> [--version-json <JSON>] [--view summary|body|raw] [--range <JSON>] [--expected-etag <etag>] [--cursor <cursor>] [--json]",
    "tent node get <nodeId> --full [--view body|raw] [--json]",
  ],
  "read-many": ["tent node read-many <nodeId> [...] [--view body|raw] [--start <index>] [--json]"],
  diff: ["tent node diff --from-json <version> --to-json <version> [--cursor <cursor>] [--json]"],
  history: ["tent node history <nodeId> [--limit <n>] [--cursor <cursor>] [--json]"],
  check: ["tent node check <nodeId> [--json]"],
  confirm: ["tent node confirm <nodeId> --base-etag <complete-live-etag> [--by <actor>] [--json]"],
  "link-output": [
    "tent node link-output <goalId> --resource <address> [--name <name>] [--tags a,b] [--by <actor>] [--role <roleId>] [--card <id>] [--json]",
  ],
  search: [
    "tent node search [query | --resource <address>] [--limit <n>] [--cursor <cursor>] [--include-archived] [--json]",
  ],
  relations: [
    "tent node relations <nodeId|root> --direction parent|children|outgoing|incoming [--limit <n>] [--cursor <cursor>] [--include-archived] [--json]",
  ],
  create: [
    "tent node create <name> --type goal|prompt|output [--parent <nodeId|root>] [--body <text>|-] [--resource <address>] [--sources-json <JSON>|-] [--tags a,b] [--by <actor>] [--json]",
  ],
  write: [
    "tent node write <nodeId> [--body <text>|-] [--confirm] --base-etag <etag> [--by <actor>] [--read-back] [--json]",
    "tent node write <nodeId> --input-json <JSON>|- [--json]",
  ],
  append: ["tent node append <nodeId> --body <text|-> [--heading <title>] [--by <actor>] [--json]"],
  "get-section": ["tent node get-section <nodeId> --heading <title> [--json]"],
  "write-section": [
    "tent node write-section <nodeId> --heading <title> --base-etag <section-etag> --body <complete-section|-> [--by <actor>] [--json]",
  ],
  "write-many": ["tent node write-many --input-json <JSON|-> [--json]"],
  rename: ["tent node rename <nodeId> <new-name> [--json]"],
  move: ["tent node move <nodeId> --parent <nodeId|root> [--json]"],
  archive: ["tent node archive <nodeId> [--json]"],
  restore: ["tent node restore <nodeId> --archive-commit <commit> [--json]"],
  delete: ["tent node delete <nodeId> [--json]"],
  type: [
    "tent node type <nodeId> goal|prompt|output --base-etag <live-etag> [--by <actor>] [--json]",
  ],
  tags: [
    "tent node tags [--include-archived] [--json]",
    "tent node tags set|add|remove <nodeId> <tag[,tag...]> --base-etag <live-etag> [--by <actor>] [--json]",
  ],
};
export function nodeHelpText(sub?: string): string {
  const commands = NODE_COMMAND_HELP;
  const notes: Record<string, string> = {
    list: "Default reads scan headers and return bounded metadata without full-document ETags. Without filters the list shows direct children; --type and repeated --tag (all must match) select matching Nodes from the whole subtree under --parent, or the Workspace. --full explicitly reads the complete tree.",
    get: 'All body/raw reads return text, including --full; view chooses the content, never the field name. Live goal first/full reads append a separate context summary up to 1 KiB; follow its ids for full content. Before replacing body/raw content, read --full or --view raw --full. Incomplete reads expose read:<etag> for continuation and metadata-only edits, never content replacement. Range JSON uses {"unit":"utf16","start":0,"end":10}. Continue a cursor with the same source, expected ETag and query. --version-json reads the captured Git document even after live edits/deletion.',
    "read-many":
      "All items share 16 KiB. Resume the input list using page.nextIndex as --start with the same Node IDs. A partial item has its own cursor: continue with node get --version-json <item.version> --cursor <item.page.nextCursor> and the same view. Each new batch observes current live documents.",
    check:
      "Inspect the computed synchronization state and output drift against current local material versions; no Hook or manual hash is needed.",
    confirm:
      "After reviewing the complete live Node and its evidence, confirm that it remains valid. Tent records current material versions and, for an output, the current versions and materials of every goal ancestor. This does not prove semantic correctness.",
    "link-output":
      "Create an output child of the selected goal; --tags adds tags, none are added automatically. Local file paths, including / addresses, resolve from the Workspace root and are saved relative to the output document. Node IDs and absolute URIs are supported. Local files must exist and be readable. The default name is the file name. Remote addresses are never fetched. The returned nodeId identifies the new output. --card explicitly selects its response Card. Automatic selection requires --role matching the receiver of exactly one incomplete Card for this goal; otherwise choose --card. The receipt names the selected Card.",
    search:
      "resource is a file path from the Workspace root (for example .tent/Node/Node.md or src/file.ts) or an absolute URI. Exact resource matching preserves query/fragment identity and does not infer bare source text.",
    create: `Body, resource, ordered sources and tags are saved together. Local material versions are recorded in Git with the Node. An output depends on every goal ancestor. The type is goal, prompt or output; tags name form and topic, preferably from tent node tags or the presets ${NODE_TAG_PRESETS.join(", ")}. Source entries use {resource, ...metadata}; local paths resolve from the Workspace root, including / addresses, and are saved relative to the new Node document. Card response sources /cards/<card-id>.md keep their .tent root. Bare sources are descriptive unless they match an existing Workspace file; use ./ for a file that does not exist yet. Node IDs and absolute URIs are supported. Inspect an uncertain result before retrying.`,
    write:
      'Write JSON: {"baseEtag":"<observed>","body":"...","frontmatter":{"resource":"src/file.ts","sources":[{"resource":".tent/Other/Other.md"}]},"confirm":true,"readBack":true}. Omitted fields and unchanged material declarations are preserved. New local material declarations in frontmatter use Workspace-root paths, as in create. A full-body output rewrite that changes its body after normalizing line endings refreshes its materials and every goal dependency. Goal/prompt saves, metadata edits, no-ops, append and write-section retain existing baselines. --confirm or confirm:true confirms the final saved content and refreshes its bases, requiring a complete live-read ETag. Unavailable known materials retain their baseline and remain behind. Baselines are retained in Git by Node ID, outside frontmatter. A read:<etag> basis permits metadata-only edits; replacing or confirming content requires the ETag from a complete read. readBack returns actual saved bytes as a bounded page; continue partial pages with node get --expected-etag and its cursor.',
    append:
      "Append under the Workspace lock without a prior read or ETag. --heading adds a level-two Markdown heading. Existing and new content are separated by one blank line; the saved body ends with one newline. Ordinary saves retain material baselines.",
    "get-section":
      "Match the unique Markdown document heading text outside lists and blockquotes. The complete section includes its heading and ends at the next same-level or higher-level heading. Code blocks do not define sections. sectionEtag authorizes replacing only this section.",
    "write-section":
      "Replace the selected section with complete Markdown from --body, including any replacement heading. The title may change or be removed. Other body bytes are preserved. Use sectionEtag from get-section; changes to other sections do not conflict. Ordinary saves retain material baselines.",
    type: "The type is what the content rests on: goal, prompt or output. Form and topic belong in tags.",
    tags: "Without arguments, list the tags of current Nodes with their counts, marking presets; --include-archived also counts deprecated Nodes. Prefer an existing tag or a preset to a new synonym. Tags add no behavior.",
    "write-many":
      'Batch JSON: {"items":[{"op":"create","ref":"rules","name":"Rules","type":"prompt","body":"..."},{"op":"update","nodeId":"node-existing","baseEtag":"<complete-read etag>","body":"...","confirm":true}]}. Create parent is null/omitted, an existing Node ID or @ref. @ref also works in Markdown links and material addresses, including forward references. New resource and sources fields use Workspace-root file paths, as in create; raw updates use stored document-relative addressing. Unchanged material declarations are preserved. Ordinary updates retain recorded material baselines; confirm:true refreshes the final saved content and output bases. All items validate before saving under one lock and one Tent commit; failures roll back the batch. Ordered results contain nodeId, path and etag. Existing Node updates require a complete read ETag; read: bases are rejected.',
  };
  const selected =
    sub && Object.prototype.hasOwnProperty.call(commands, sub) ? [sub] : Object.keys(commands);
  return [
    `tent node — direct Core operations`,
    "",
    ...selected.flatMap((key) => commands[key]),
    "",
    ...new Set(selected.map((key) => notes[key]).filter(Boolean)),
    ...(selected.some((key) =>
      ["create", "link-output", "search", "write", "write-many"].includes(key),
    )
      ? [
          "Git Bash rewrites arguments that start with / (such as /docs/x.md) into Windows paths; run the command with MSYS_NO_PATHCONV=1 to keep them.",
        ]
      : []),
    "All commands accept --workspace <path>. Options accept --key=value; use -- to end options.",
    "Content writes and confirmations accept --by <actor>; JSON writes accept by in the input. Accepted actor formats are human:<id>, process:<id>, and <producer>/<version>. Without a known actor, Tent records tent/<version>.",
    "Use --body - or --prompt - where supported to read stdin. Mutations use the Workspace lock and capture selected Git versions.",
  ].join("\n");
}

function nodeRef(value: string): string {
  if (!isNodeId(value)) throw new Error(`Expected canonical Node id (node-*): ${value}`);
  return value;
}

function validateActor(value: unknown, field: string): void {
  if (!nodeActorSchema.safeParse(value).success)
    throw new Error(`${field} must use human:<id>, process:<id>, or <producer>/<version>.`);
}

async function selectedPath(fs: NodeFs, id: string) {
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

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Node editing read ${label} must be a string array.`);
  }
  return value;
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
        ["json", "full", "include-archived", "read-back", "confirm"].map((name) => [
          name,
          { type: "boolean" as const },
        ]),
      ),
      ...Object.fromEntries(
        [
          "workspace",
          "parent",
          "limit",
          "cursor",
          "view",
          "range",
          "start",
          "expected-etag",
          "version-json",
          "from-json",
          "to-json",
          "resource",
          "name",
          "card",
          "role",
          "by",
          "direction",
          "type",
          "body",
          "heading",
          "sources-json",
          "tags",
          "base-etag",
          "archive-commit",
          "input-json",
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

function formatReader(value: unknown): string {
  return formatWithContext(value, formatReaderContent);
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
      description?: string;
      text?: string;
      view?: string;
      etag?: string;
    };
    items?: Array<{
      nodeId?: string;
      name?: string;
      description?: string;
      title?: string;
      text?: string;
      commit?: string;
      operation?: string;
      time?: string;
    }>;
    page?: { hasMore: boolean; nextCursor?: string; nextIndex?: number };
  };
  if (result.node) {
    const etag = result.node.etag ? `\nETag: ${result.node.etag}` : "";
    return result.node.text !== undefined
      ? `${result.node.nodeId}  ${result.node.view}${etag}\n${formatTextPage(result.node)}`
      : `${result.node.nodeId}  ${result.node.name ?? ""}${etag}\n${result.node.description ?? ""}`;
  }
  if (result.items)
    return (
      `${result.items.map((item) => (item.text !== undefined ? `${item.nodeId}\n${formatTextPage(item)}` : [item.commit, item.time, item.operation, item.nodeId, item.name ?? item.title, item.description].filter(Boolean).join("  "))).join("\n")}${result.page?.hasMore ? `\nNext: ${result.page.nextCursor ?? result.page.nextIndex}` : ""}` ||
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

function usage(text: string): NodeCommandResult {
  return { exitCode: 1, stdout: "", stderr: text.trimEnd() + "\n" };
}

function formatNode(value: unknown): string {
  const node = (value as { node?: NodeProjection }).node;
  if (!node) return JSON.stringify(value);
  return `${node.nodeId}  ${node.type}  ${node.path}`;
}

function formatTree(nodes: NodeProjection[]): string {
  const lines: string[] = [];
  const visit = (node: NodeProjection, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${node.nodeId}  ${node.type}  ${node.name}`);
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
