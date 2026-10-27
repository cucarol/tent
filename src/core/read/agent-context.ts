import path from "node:path";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import type { DocumentVersion } from "../store/history-port.js";
import { loadTent } from "../store/tree.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { nodeNotePath } from "../base/paths.js";
import { documentLifecycle } from "../base/document-status.js";
import {
  materialLocator,
  localMaterialPath,
  materialOccurrences,
  type MaterialSource,
} from "../base/material.js";
import { markdownMaterialHeading } from "../base/material-section.js";
import { selectSection } from "../base/markdown-section.js";
import {
  structureMaterialCoverage,
  materialCoverageContains,
  isTentWorkspacePath,
} from "../base/material-coverage.js";
import { extractRepositoryTestImports, type RepositorySource } from "../base/repository-imports.js";
import { verifyCardSourceVersions, listCardDocuments } from "../graph/card-document.js";
import { readOutputChanges } from "../graph/node-sync.js";
import { canonicalSha256 } from "../base/canonical-digest.js";
import { contentEtag } from "../base/etag.js";
import { isNodeId } from "../base/id.js";
import { resolveTargetPath } from "../base/link-target.js";
import {
  historicalContextNodes,
  readCardBodyReferences,
  resolveBodyNodeReferences,
  type BodyNodeReference,
  type ContextNode,
  withoutCode,
} from "./card-references.js";
import { readNodeTimes } from "./node-times.js";
import { compareBriefCards } from "./context-brief.js";

export type AgentContextStart =
  | { kind: "node"; nodeId: string; version?: DocumentVersion }
  | { kind: "resource"; resource: string }
  | { kind: "card"; cardId: string }
  | { kind: "brief"; roleId?: string };
export type AgentContextRepository = {
  trackedFiles: readonly string[];
  sources: {
    files: readonly RepositorySource[];
    errors: readonly { file: string; reason: string }[];
  };
};
export type AgentContextItem = {
  why: string;
  nodeId?: string;
  cardId?: string;
  title?: string;
  path?: string;
  text?: string;
  version?: DocumentVersion;
  heading?: string;
  command?: string;
  truncated?: true;
  at?: string;
  state?: string;
};
const categories = [
  "references",
  "rules",
  "paths",
  "tests",
  "changes",
  "decisions",
  "open",
  "unknown",
] as const;
type Category = (typeof categories)[number];
export type AgentContext = {
  start: AgentContextStart;
  revision: string;
  sections: {
    kind: Category;
    items: AgentContextItem[];
    total: number;
    omitted: number;
    next?: { offset: number; expectedRevision: string };
  }[];
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const quote = (value: string) =>
  process.platform === "win32"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'"'"'`)}'`;
function command(start: AgentContextStart, workspaceRoot: string) {
  const workspace = ` --workspace ${quote(workspaceRoot)}`;
  if (start.kind === "card") return `tent card show ${start.cardId}${workspace}`;
  if (start.kind === "resource")
    return `tent node search --resource ${quote(localMaterialPath(materialLocator(start.resource, "index.md", true), workspaceRoot) ?? start.resource)}${workspace}`;
  if (start.kind === "brief")
    return `tent workspace brief${start.roleId ? ` --role ${start.roleId}` : ""}${workspace}`;
  return `tent node get ${start.nodeId}${start.version ? ` --version-json ${quote(JSON.stringify(start.version))}` : ""}${workspace}`;
}
function excerpt(text: string, maximum = 1600) {
  const characters = Array.from(text);
  if (characters.length <= maximum) return { text };
  let value = characters.slice(0, maximum).join("");
  if (value.endsWith("\r") && characters[maximum] === "\n") value = value.slice(0, -1);
  return { text: value, truncated: true as const };
}
// Literal first prose line/sentence, never a generated semantic summary.
function sentence(body: string) {
  let prose = body;
  try {
    prose = parseFrontmatter(body).body;
  } catch {
    // A thematic break or invalid metadata block remains Markdown, not synthesized prose.
  }
  const thematicBreak = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
  const line =
    prose
      .split(/\r?\n/)
      .find((line) => line.trim() && !/^\s*#/.test(line) && !thematicBreak.test(line)) ?? "";
  return excerpt(line.match(/^.*?(?:[。！？]|[.!?](?:\s|$))/)?.[0] ?? line, 120);
}

// Missing prose examples are link-check work, not uncertainty about an established source.
function missingProseId(ref: BodyNodeReference, nodes: readonly ContextNode[]) {
  const id = resolveTargetPath(ref.raw);
  return (
    !ref.nodeId && !ref.targetNodeId && isNodeId(id) && !nodes.some((node) => node.nodeId === id)
  );
}

/** Assemble evidence only. No capture, confirmation, repair, clocks, Git commands or persistent summary. */
export async function assembleAgentContext(
  inputFs: FsAdapter,
  workspaceRoot: string,
  start: AgentContextStart,
  options: {
    repository?: AgentContextRepository | (() => Promise<AgentContextRepository>);
    offset?: number;
    expectedRevision?: string;
  } = {},
): Promise<AgentContext> {
  const fs = readOnlyFs(inputFs);
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Context offset must be a nonnegative integer");
  if (offset > 0 && !options.expectedRevision)
    throw new Error("A context continuation requires expectedRevision");
  const run = async () => {
    const items: Record<Category, AgentContextItem[]> = {
      references: [],
      rules: [],
      paths: [],
      tests: [],
      changes: [],
      decisions: [],
      open: [],
      unknown: [],
    };
    const unknown = (why: string, extra: Partial<AgentContextItem> = {}) =>
      items.unknown.push({ why, ...extra });
    const historicalOnly = start.kind === "node" && !!start.version;
    const tree = historicalOnly ? undefined : await loadTent(fs);
    const live: ContextNode[] = await Promise.all(
      [...(tree?.byPath.values() ?? [])]
        .filter((node) => !node.invalid)
        .map(async (node) => {
          const raw = await fs.readFile(nodeNotePath(node.path));
          if (contentEtag(raw) !== node.etag)
            throw new Error("Node source changed during context assembly; retry");
          return {
            nodeId: node.id,
            path: node.path,
            name: node.name,
            raw,
            body: node.body,
            data: node.fm,
          };
        }),
    );
    const liveById = new Map(live.map((node) => [node.nodeId, node]));
    const active = (node: ContextNode) => documentLifecycle(node.data).status === "stable";
    const baseCommand = command(start, workspaceRoot);
    const roots: {
      node: ContextNode;
      heading?: string;
      why: string;
      universe: readonly ContextNode[];
    }[] = [];
    const rootIds = new Set<string>();
    const observedCards: { cardId: string; hash: string }[] = [];
    const observedEffects: unknown[] = [];
    const files = new Map<string, string>();
    let repository: AgentContextRepository | undefined;
    if (start.kind !== "brief" && !(start.kind === "node" && start.version)) {
      try {
        repository =
          typeof options.repository === "function"
            ? await options.repository()
            : options.repository;
      } catch (error) {
        unknown(`Current repository evidence unavailable: ${String(error)}`);
      }
      if (!repository)
        unknown(
          "Current repository file/import evidence unavailable; no test coverage can be inferred",
        );
    }
    const addFile = (file: string, why: string) => {
      if (!isTentWorkspacePath(file)) files.set(file, files.get(file) ?? why);
    };
    const localPath = (resource: string, owner: string) => {
      const locator = materialLocator(resource, owner, true);
      const filename = localMaterialPath(locator, workspaceRoot);
      if (!filename) return;
      const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/");
      if (
        relative === ".." ||
        relative.startsWith("../") ||
        path.isAbsolute(relative) ||
        isTentWorkspacePath(relative)
      )
        return;
      return { relative, locator };
    };
    const addMaterials = (node: ContextNode) => {
      for (const occurrence of materialOccurrences(node.data)) {
        try {
          const local = localPath(occurrence.resource, nodeNotePath(node.path));
          if (!local) {
            unknown(`Material cannot establish a local code path: ${occurrence.resource}`, {
              nodeId: node.nodeId,
            });
            continue;
          }
          const coverage = structureMaterialCoverage(
            occurrence.resource,
            nodeNotePath(node.path),
            workspaceRoot,
          );
          const why = `${node.nodeId} ${occurrence.field}${node.version ? " in retained version" : ""}: ${occurrence.resource}`;
          if (coverage && repository) {
            const members = repository.trackedFiles.filter((file) =>
              materialCoverageContains(coverage, file),
            );
            for (const member of members) addFile(member, why);
            if (!members.length)
              unknown(`No tracked members found for ${occurrence.resource}`, {
                nodeId: node.nodeId,
              });
          } else addFile(local.relative, why);
        } catch (error) {
          unknown(`Material address unavailable: ${String(error)}`, { nodeId: node.nodeId });
        }
      }
    };
    const addRoot = (
      node: ContextNode,
      why: string,
      universe: readonly ContextNode[],
      heading?: string,
    ) => {
      let text = node.body;
      if (heading !== undefined) {
        try {
          text = selectSection(node.body, heading).text;
        } catch (error) {
          unknown(`Referenced section unavailable: ${String(error)}`, {
            nodeId: node.nodeId,
            ...(node.version ? { version: node.version } : {}),
          });
          heading = undefined;
        }
      }
      roots.push({ node, heading, why, universe });
      rootIds.add(node.nodeId);
      items.references.push({
        nodeId: node.nodeId,
        title: node.name,
        path: `.tent/${nodeNotePath(node.path)}`,
        why,
        ...(node.version ? { version: node.version } : {}),
        ...(heading ? { heading } : {}),
        ...excerpt(text),
        command:
          `tent node get ${node.nodeId} --full${node.version ? ` --version-json ${quote(JSON.stringify(node.version))}` : ""} --workspace ${quote(workspaceRoot)}`.replace(
            " --full --version-json",
            " --version-json",
          ),
      });
      addMaterials(node);
    };
    if (start.kind === "node") {
      const universe = start.version
        ? await historicalContextNodes(fs, start.version.commit)
        : live;
      const node = universe.find(
        (node) =>
          node.nodeId === start.nodeId &&
          (!start.version || node.version?.path === start.version.path),
      );
      if (!node) throw new Error("Selected Node identity/path is unavailable in this source");
      addRoot(
        node,
        start.version ? "Explicit immutable Node version" : "Selected live Node",
        universe,
      );
      if (start.version)
        unknown(
          "Current modules, tests and open work are not substituted into a historical Node source",
        );
    } else if (start.kind === "resource") {
      const local = localPath(start.resource, "index.md");
      if (local) addFile(local.relative, "Explicit file starting point");
      else unknown("Starting resource is not a local workspace file");
      if (local)
        for (const node of live.filter(active)) {
          if (
            materialOccurrences(node.data).some((occurrence) => {
              const coverage = structureMaterialCoverage(
                occurrence.resource,
                nodeNotePath(node.path),
                workspaceRoot,
              );
              try {
                return coverage
                  ? materialCoverageContains(coverage, local.relative)
                  : localPath(occurrence.resource, nodeNotePath(node.path))?.relative ===
                      local.relative;
              } catch {
                return false;
              }
            })
          )
            addRoot(node, `Node material directly matches starting file ${local.relative}`, live);
        }
    } else if (start.kind === "card") {
      try {
        const body = await readCardBodyReferences(fs, start.cardId);
        items.references.push({
          cardId: start.cardId,
          path: `.tent/${body.card.path}`,
          why: "Immutable published Card request",
          version: body.publication,
          ...excerpt(body.card.body),
          command: baseCommand,
        });
        const sources = body.card.data.sources;
        const sourceHeadings = (node: ContextNode, explicit?: string): (string | undefined)[] => {
          if (explicit !== undefined) return [explicit];
          const selections = body.references.filter(
            (ref) =>
              ref.heading !== undefined &&
              (ref.nodeId === node.nodeId ||
                ref.targetNodeId === node.nodeId ||
                (ref.kind === "mention" && ref.raw === node.nodeId)) &&
              (!ref.version ||
                (ref.version.commit === node.version?.commit &&
                  ref.version.path === node.version?.path)),
          );
          if (!selections.length) return [undefined];
          const headings = [
            ...new Set(
              selections.filter((ref) => ref.nodeId && !ref.reason).map((ref) => ref.heading!),
            ),
          ];
          if (headings.length > 1) {
            unknown(
              `Ambiguous literal sections for ${node.nodeId}; qualify each source with #Title`,
              { nodeId: node.nodeId, version: node.version },
            );
            return [undefined];
          }
          // Invalid literal selectors remain diagnostics, but cannot erase an explicit source.
          return headings.length ? headings : [undefined];
        };
        const verified = await verifyCardSourceVersions(
          fs,
          sources
            .filter((source) => source.version !== undefined)
            .map((source) => ({ owner: body.card.path, source })),
        );
        let index = 0;
        for (const source of sources) {
          if (source.version === undefined) {
            const refs = resolveBodyNodeReferences(
              `[source](${source.resource.split("#")[0]})`,
              body.card.path,
              body.nodes,
            );
            const ref = refs.find((ref) => ref.nodeId);
            const node = ref ? body.nodes.find((node) => node.nodeId === ref.nodeId) : undefined;
            if (node)
              for (const heading of sourceHeadings(
                node,
                markdownMaterialHeading(materialLocator(source.resource, body.card.path, true)),
              ))
                addRoot(
                  node,
                  `Unpinned legacy Card source resolved at publication: ${source.resource}`,
                  body.nodes,
                  heading,
                );
            else {
              const failed = refs.find((ref) => ref.reason && ref.scope === "node");
              if (failed) {
                unknown(`Legacy Card source ${source.resource}: ${failed.reason}`, {
                  ...(failed.targetNodeId ? { nodeId: failed.targetNodeId } : {}),
                  ...(failed.version ? { version: failed.version } : {}),
                });
                continue;
              }
              addMaterials({
                ...body.card,
                nodeId: start.cardId,
                name: start.cardId,
                data: { sources: [source] },
              });
            }
            continue;
          }
          const read = verified[index++];
          if (!read || read instanceof Error) {
            unknown(
              `Pinned Card source unavailable: ${read instanceof Error ? read.message : source.resource}`,
            );
            continue;
          }
          const universe = await historicalContextNodes(fs, read.version.commit);
          const node = universe.find(
            (node) =>
              node.version?.path === read.version.path &&
              node.nodeId === String(parseFrontmatter(read.raw).data.id),
          );
          if (!node) {
            unknown("Pinned source is not a unique historical Node", { version: read.version });
            continue;
          }
          const heading = markdownMaterialHeading(
            materialLocator(source.resource, body.card.path, true),
          );
          for (const selectedHeading of sourceHeadings(node, heading))
            addRoot(
              node,
              `Card ${start.cardId} pinned source: ${source.resource}`,
              universe,
              selectedHeading,
            );
        }
        for (const ref of body.references) {
          if (missingProseId(ref, body.nodes)) continue;
          if (ref.nodeId) {
            const universe = ref.version
              ? await historicalContextNodes(fs, ref.version.commit)
              : body.nodes;
            const node = universe.find(
              (node) =>
                node.nodeId === ref.nodeId &&
                (!ref.version || node.version?.path === ref.version.path),
            );
            if (!node) {
              unknown(`Card body target unavailable: ${ref.raw}`);
              continue;
            }
            const text = ref.heading ? selectSection(node.body, ref.heading).text : node.body;
            items.decisions.push({
              nodeId: node.nodeId,
              title: node.name,
              path: `.tent/${nodeNotePath(node.path)}`,
              why: `Published Card body ${ref.kind}: ${ref.raw}`,
              ...sentence(text),
              ...(ref.heading ? { heading: ref.heading } : {}),
              version: ref.version,
              command: `tent node get ${node.nodeId} --version-json ${quote(JSON.stringify(ref.version))} --workspace ${quote(workspaceRoot)}`,
            });
            const current = liveById.get(ref.nodeId);
            if (current)
              items.decisions.push({
                nodeId: ref.nodeId,
                path: `.tent/${nodeNotePath(current.path)}`,
                why: `Card body target verified at publication: ${ref.raw} → ${ref.nodeId} → .tent/${nodeNotePath(current.path)}`,
              });
            else
              unknown(`Published Card target ${ref.nodeId} has no current path`, {
                version: ref.version,
              });
          } else {
            try {
              const local = localPath(ref.raw, body.card.path);
              if (local && repository?.trackedFiles.includes(local.relative))
                items.decisions.push({
                  path: local.relative,
                  why: `Published Card body file reference; current file presence: ${ref.raw}`,
                });
              else
                unknown(`Card body reference: ${ref.raw}; ${ref.reason}`, {
                  ...(ref.targetNodeId ? { nodeId: ref.targetNodeId } : {}),
                  ...(ref.version ? { version: ref.version } : {}),
                });
            } catch {
              unknown(`Card body reference: ${ref.raw}; ${ref.reason}`, {
                ...(ref.targetNodeId ? { nodeId: ref.targetNodeId } : {}),
                ...(ref.version ? { version: ref.version } : {}),
              });
            }
          }
        }
        // Only exact existing repository paths are recognized in prose; no filename or semantic guessing.
        for (const file of repository?.trackedFiles ?? []) {
          const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (
            new RegExp(`(^|[^\\w/.-])${escaped}(?=$|[^\\w/.-]|[.](?=\\s|$))`).test(
              withoutCode(body.card.body),
            )
          )
            items.decisions.push({
              path: file,
              why: "Literal file reference in published Card prose; publication file presence is unknown",
            });
        }
      } catch (error) {
        unknown(
          `Card publication context unavailable: ${String(error)}; current paths were not used as historical substitutes`,
        );
      }
    } else {
      const times = await readNodeTimes(
        fs,
        live.filter(active).map((node) => node.nodeId),
      );
      for (const time of times
        .filter((time) => time.contentChangedAt)
        .sort(
          (a, b) =>
            compare(b.contentChangedAt!, a.contentChangedAt!) || compare(a.nodeId, b.nodeId),
        )) {
        const node = liveById.get(time.nodeId)!;
        items.references.push({
          nodeId: node.nodeId,
          title: node.name,
          path: `.tent/${nodeNotePath(node.path)}`,
          at: time.contentChangedAt!,
          why: "Latest retained body/material change; no session attribution",
          command: `tent node get ${node.nodeId} --workspace ${quote(workspaceRoot)}`,
        });
      }
      unknown(
        "Session ownership is unavailable; retained Node change times and unfinished Cards prove current facts only.",
      );
    }

    const scopes = new Set(rootIds);
    const summarize = (node: ContextNode, why: string, heading?: string): AgentContextItem => ({
      nodeId: node.nodeId,
      title: node.name,
      path: `.tent/${nodeNotePath(node.path)}`,
      why,
      ...sentence(heading ? selectSection(node.body, heading).text : node.body),
      ...(heading ? { heading } : {}),
      ...(node.version ? { version: node.version } : {}),
      command: `tent node get ${node.nodeId}${node.version ? ` --version-json ${quote(JSON.stringify(node.version))}` : " --full"} --workspace ${quote(workspaceRoot)}`,
    });
    for (const root of roots) {
      const selectedBody = root.heading
        ? selectSection(root.node.body, root.heading).text
        : root.node.body;
      for (const file of repository?.trackedFiles ?? []) {
        const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (
          new RegExp(`(^|[^\\w/.-])${escaped}(?=$|[^\\w/.-]|[.](?=\\s|$))`).test(
            withoutCode(selectedBody),
          )
        )
          items.decisions.push({
            path: file,
            why: `Literal file reference in selected prose of ${root.node.nodeId}`,
          });
      }
      const parents = root.node.path.split("/");
      parents.pop();
      while (parents.length) {
        const parent = root.universe.find((node) => node.path === parents.join("/"));
        if (parent?.data.type === "goal") {
          items.rules.push(
            summarize(parent, `Ancestor goal of ${root.node.nodeId} in the same source`),
          );
        }
        parents.pop();
      }
      for (const candidate of root.universe) {
        const outgoing = candidate.nodeId === root.node.nodeId;
        const refs = resolveBodyNodeReferences(
          outgoing && root.heading
            ? selectSection(candidate.body, root.heading).text
            : candidate.body,
          nodeNotePath(candidate.path),
          root.universe,
        );
        for (const ref of refs) {
          if (missingProseId(ref, root.universe)) continue;
          const target = ref.nodeId
            ? root.universe.find((node) => node.nodeId === ref.nodeId)
            : undefined;
          if (outgoing && target && target.nodeId !== root.node.nodeId)
            items.decisions.push(
              summarize(
                target,
                `${root.node.nodeId} ${ref.kind} to this Node in the same source: ${ref.raw}`,
                ref.heading,
              ),
            );
          else if (outgoing && !target) {
            let local;
            try {
              local = localPath(ref.raw, nodeNotePath(candidate.path));
            } catch {
              /* Unknown below. */
            }
            if (local && repository?.trackedFiles.includes(local.relative))
              items.decisions.push({
                path: local.relative,
                why: `File link in selected prose of ${root.node.nodeId}: ${ref.raw}`,
              });
            else if (ref.reason) unknown(`${root.node.nodeId} reference ${ref.raw}: ${ref.reason}`);
          } else if (!outgoing && ref.nodeId === root.node.nodeId)
            items.decisions.push(
              summarize(
                candidate,
                `${ref.kind} from this Node to ${root.node.nodeId} in the same source: ${ref.raw}`,
              ),
            );
        }
      }
      if (!root.node.version && root.node.data.type === "output") {
        try {
          const changed = await readOutputChanges(fs, root.node.nodeId);
          observedEffects.push(changed ?? null);
          if (changed)
            items.changes.push({
              nodeId: root.node.nodeId,
              why: "Existing retained output basis comparison",
              ...excerpt(JSON.stringify(changed)),
              command: `tent node get ${root.node.nodeId} --full --workspace ${quote(workspaceRoot)}`,
            });
        } catch (error) {
          unknown(`Output basis comparison unavailable: ${String(error)}`, {
            nodeId: root.node.nodeId,
          });
        }
      }
      if (root.node.version && !historicalOnly) {
        const current = liveById.get(root.node.nodeId);
        if (!current)
          unknown("Historical identity has no live Node to compare", {
            nodeId: root.node.nodeId,
            version: root.node.version,
          });
        else if (current.raw !== root.node.raw) {
          // Adapter-provided diffs require two retained versions; never capture dirty live bytes.
          const latest = (await fs.history?.pathVersions(nodeNotePath(current.path)))?.latest;
          if (latest && (await fs.history!.read(latest)) === current.raw) {
            try {
              items.changes.push({
                nodeId: root.node.nodeId,
                version: root.node.version,
                why: "Pinned source compared with current retained bytes for the same Node id",
                ...excerpt(await fs.history!.diff(root.node.version, latest)),
                command: [root.node.version, latest]
                  .map(
                    (version) =>
                      `tent node get ${root.node.nodeId} --version-json ${quote(JSON.stringify(version))} --view raw --json --workspace ${quote(workspaceRoot)}`,
                  )
                  .join("\n"),
              });
            } catch (error) {
              unknown(`Retained diff unavailable: ${String(error)}`, { nodeId: root.node.nodeId });
            }
          } else
            unknown("Current bytes are not retained; no historical diff was substituted", {
              nodeId: root.node.nodeId,
            });
        }
      }
    }
    for (const [file, why] of files) items.paths.push({ path: file, why });
    if (!historicalOnly) {
      for (const [file] of files) {
        const owners: ContextNode[] = [];
        for (const node of live.filter((node) => active(node) && node.data.type === "goal")) {
          for (const occurrence of materialOccurrences(node.data)) {
            const coverage = structureMaterialCoverage(
              occurrence.resource,
              nodeNotePath(node.path),
              workspaceRoot,
            );
            if (coverage && materialCoverageContains(coverage, file)) {
              owners.push(node);
              break;
            }
          }
        }
        if (!owners.length) unknown(`No module covers ${file}`, { path: file });
        for (const owner of owners) {
          items.rules.push(summarize(owner, `Module material covers ${file}`));
          for (const rule of live.filter(
            (node) =>
              active(node) &&
              node.data.type === "prompt" &&
              path.posix.dirname(node.path) === owner.path,
          ))
            items.rules.push(
              summarize(rule, `Rule directly under module ${owner.nodeId}, which covers ${file}`),
            );
        }
      }
      if (repository) {
        const evidence = extractRepositoryTestImports(repository.sources.files);
        const testWitnesses = new Map<string, Set<string>>();
        for (const edge of evidence.edges) {
          const matched =
            edge.kind === "file"
              ? files.has(edge.to)
              : [...files.keys()].some((file) => path.posix.dirname(file) === edge.to);
          if (matched) {
            const witnesses = testWitnesses.get(edge.from) ?? new Set<string>();
            witnesses.add(`${edge.to} (${edge.specifier})`);
            testWitnesses.set(edge.from, witnesses);
          }
        }
        for (const [file, witnesses] of testWitnesses)
          items.tests.push({
            path: file,
            why: `Static test import evidence to ${[...witnesses].sort(compare).join("; ")}; unique value re-export definitions are included; execution coverage is not inferred`,
          });
        if (files.size && !items.tests.length)
          unknown(
            "No tests found in the supplied static import evidence; this does not prove absence of tests",
          );
        for (const error of repository.sources.errors.filter((error) => files.has(error.file)))
          unknown(`Referenced repository source unavailable: ${error.file}: ${error.reason}`);
        if (evidence.issues.length || repository.sources.errors.length)
          unknown(
            `Static test discovery is incomplete: ${evidence.issues.length} import/configuration issues and ${repository.sources.errors.length} source read errors in the supplied repository; no missing edge is treated as proof of no tests`,
            { command: `tent workspace check-modules --json --workspace ${quote(workspaceRoot)}` },
          );
      }
      const cards = await listCardDocuments(fs, {
        unfinishedOnly: true,
        ...(start.kind === "brief" && start.roleId
          ? { roleId: start.roleId, includeOpen: true }
          : {}),
      });
      for (const card of start.kind === "brief"
        ? [...cards.items].sort((a, b) => compareBriefCards(a, b, start.roleId))
        : cards.items) {
        if (
          start.kind === "brief" &&
          start.roleId &&
          card.state === "returned" &&
          card.returnTo !== start.roleId &&
          !card.diagnostic
        )
          continue;
        if (card.diagnostic) {
          unknown(`Card state unavailable: ${card.cardId}: ${String(card.diagnostic)}`);
          continue;
        }
        try {
          const cardPath = `cards/${String(card.cardId)}.md`;
          const retained = (await fs.history?.pathVersions(cardPath))?.latest;
          const raw = await fs.readFile(cardPath);
          observedCards.push({ cardId: String(card.cardId), hash: canonicalSha256(raw) });
          if (!retained || (await fs.history!.read(retained)) !== raw)
            throw new Error("No matching retained current bytes");
        } catch (error) {
          unknown(
            `Card ${String(card.cardId)} state is unknown: ${String(error)}; its live header is not evidence of an unfinished task`,
          );
          continue;
        }
        let related =
          start.kind === "brief" || (start.kind === "card" && card.cardId === start.cardId);
        if (!related) {
          let cardSources: MaterialSource[] = [];
          try {
            const published = await readCardBodyReferences(fs, String(card.cardId));
            cardSources = published.card.data.sources;
            related = cardSources
              .filter((source) => source.version === undefined)
              .some((source) =>
                resolveBodyNodeReferences(
                  `[source](${source.resource})`,
                  published.card.path,
                  published.nodes,
                ).some((ref) => !!ref.nodeId && scopes.has(ref.nodeId)),
              );
          } catch {
            /* A missing publication establishes no task relationship. */
          }
          if (!related && cardSources.length) {
            const values = await verifyCardSourceVersions(
              fs,
              cardSources
                .filter((source) => source.version !== undefined)
                .map((source) => ({ owner: `cards/${card.cardId}.md`, source })),
            );
            related = values.some(
              (value) =>
                !(value instanceof Error) &&
                scopes.has(String(parseFrontmatter(value.raw).data.id)),
            );
          }
        }
        if (related)
          items.open.push({
            cardId: String(card.cardId),
            title: String(card.title ?? card.cardId),
            state: String(card.state),
            why: `Current unfinished Card state: ${String(card.state)}`,
            command: `tent card show ${card.cardId} --workspace ${quote(workspaceRoot)}`,
          });
      }
    }
    for (const root of roots) {
      for (const goal of root.universe.filter(
        (node) =>
          node.data.type === "goal" &&
          active(node) &&
          (node.nodeId === root.node.nodeId || path.posix.dirname(node.path) === root.node.path),
      )) {
        if (
          !root.universe.some(
            (node) =>
              active(node) && node.data.type === "output" && node.path.startsWith(goal.path + "/"),
          )
        )
          items.open.push(
            summarize(
              goal,
              `No active output in this root/direct-child goal; not proof of unfinished work; ${root.node.nodeId} scope`,
            ),
          );
      }
    }
    if (files.size)
      unknown(
        "Material baselines retain fingerprints, not old project source bytes. Source-code line diffs since confirmation cannot be reconstructed from those baselines; retained Node versions are compared separately above.",
      );
    const complete = categories.map((kind) => {
      const grouped = new Map<string, { item: AgentContextItem; reasons: Set<string> }>();
      for (const item of items[kind]) {
        const key = item.nodeId
          ? JSON.stringify([item.nodeId, item.version?.commit, item.version?.path, item.heading])
          : JSON.stringify(item);
        const previous = grouped.get(key);
        if (previous) {
          previous.item = { ...item, ...previous.item };
          previous.reasons.add(item.why);
        } else grouped.set(key, { item, reasons: new Set([item.why]) });
      }
      const ordered = [...grouped.values()].map(({ item, reasons }) => ({
        ...item,
        why: [...reasons].sort(compare).join("; "),
      }));
      if (
        !(start.kind === "card" && kind === "references") &&
        !(start.kind === "brief" && kind === "open")
      )
        ordered.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
      if (start.kind === "brief" && kind === "references")
        ordered.sort(
          (a, b) => compare(b.at ?? "", a.at ?? "") || compare(a.nodeId ?? "", b.nodeId ?? ""),
        );
      return { kind, items: ordered };
    });
    const observations = [
      ...new Map(
        [...live, ...roots.flatMap((root) => root.universe)].map((node) => [
          JSON.stringify([node.version ?? "live", node.nodeId, node.path]),
          {
            nodeId: node.nodeId,
            path: node.path,
            ...(node.version ? { version: node.version } : {}),
            hash: canonicalSha256(node.raw),
          },
        ]),
      ).values(),
    ].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    const repositorySource = repository
      ? {
          trackedFiles: [...repository.trackedFiles].sort(compare),
          files: repository.sources.files
            .map((file) => ({
              path: file.path,
              hash: file.content === undefined ? null : canonicalSha256(file.content),
            }))
            .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
          errors: [...repository.sources.errors].sort((a, b) =>
            compare(JSON.stringify(a), JSON.stringify(b)),
          ),
        }
      : undefined;
    const revision = canonicalSha256({
      workspaceRoot,
      start,
      complete,
      observations,
      cards: observedCards.sort((a, b) => compare(a.cardId, b.cardId)),
      repository: repositorySource,
      effects: observedEffects,
    });
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision)
      throw new Error(
        "Context source changed; restart assembly instead of mixing continuation pages",
      );
    return {
      start,
      revision,
      sections: complete.map(({ kind, items }) => ({
        kind,
        items: items.slice(offset, offset + 10),
        total: items.length,
        omitted: Math.max(0, items.length - offset - 10),
        ...(offset + 10 < items.length
          ? { next: { offset: offset + 10, expectedRevision: revision } }
          : {}),
      })),
    };
  };
  return fs.observationScope ? fs.observationScope(run) : run();
}

/** Shared rendering keeps CLI entry points thin; every item retains its evidence reason. */
export function formatAgentContext(context: AgentContext) {
  return [
    "Agent context",
    ...context.sections.flatMap((section) => [
      `${section.kind} (${section.total})`,
      ...section.items.map((item) =>
        [
          `- ${[item.nodeId ?? item.cardId, item.title, item.path].filter(Boolean).join(" ") || "Evidence"}: ${item.why}`,
          item.version ? `  Version: ${JSON.stringify(item.version)}` : "",
          item.heading ? `  Section: ${item.heading}` : "",
          item.text ?? "",
          item.truncated ? "  Excerpt truncated; read the source for the remaining bytes." : "",
          item.command ? `  Read: ${item.command}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      ...(section.next ? [`Continue API with: ${JSON.stringify(section.next)}`] : []),
    ]),
  ].join("\n");
}
