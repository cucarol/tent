import * as z from "zod/v4";
import type { FsAdapter } from "../store/adapter.js";
import { canonicalJson } from "../base/canonical-digest.js";
import { parseFrontmatter, serializeFrontmatter } from "../base/frontmatter.js";
import {
  materialIdentity,
  materialLocator,
  materialOccurrences,
  isCardResponseSource,
  isDirectoryMaterial,
  isPrefixMaterial,
} from "../base/material.js";
import { materialContent, markdownMaterialHeading } from "../base/material-section.js";
import { recordNodeVerification } from "../base/node-provenance.js";
import { loadNodeCatalog, type CatalogNode } from "./node-catalog.js";
import { nodeNotePath } from "../base/paths.js";
import { isCoverageGoal } from "../base/material-coverage.js";
import { rewriteMarkdownDestinations } from "../base/links.js";
import { createHash } from "node:crypto";
import { cachedSemanticContent } from "../base/semantic-content-cache.js";
import { markdownSyntax } from "../base/markdown-syntax.js";
import { assertSystemMaterial, systemMaterialPath } from "./material-target.js";

import type { NodeBasisRecord } from "../base/node-basis-record.js";
export { nodeBasisRecordSchema, type NodeBasisRecord } from "../base/node-basis-record.js";
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const retiredNodeFields = [
  "sync",
  "planned",
  "outputs",
  "sha256",
  "resource_sha256",
  "supersedes",
] as const;

export function assertNodeRecordFields(data: Record<string, unknown>): void {
  for (const field of retiredNodeFields)
    if (data[field] !== undefined)
      throw new Error(`Node field ${field} is retired; remove it from the document`);
  if (Array.isArray(data.sources))
    for (const source of data.sources)
      if (source.sha256 !== undefined || source.resource_sha256 !== undefined)
        throw new Error("Material hashes belong to the Git record layer, not Node sources");
}

export function isRequirementNode(data: { type?: unknown }): boolean {
  return data.type === "goal";
}
/** Ancestors of current coverage goals; callers still require the owner itself to be a goal. */
export function coverageGoalAncestors(
  nodes: Map<string, CatalogNode>,
  workspaceRoot: string | undefined,
): Set<string> {
  const ancestors = new Set<string>();
  if (!workspaceRoot) return ancestors;
  for (const node of nodes.values()) {
    if (
      node.invalid ||
      node.archived ||
      node.type !== "goal" ||
      parseFrontmatter(node.header).data.status === "draft"
    )
      continue;
    if (
      !isCoverageGoal(
        { ...parseFrontmatter(node.header).data, type: node.type },
        nodeNotePath(node.path),
        workspaceRoot,
      )
    )
      continue;
    let parent = node.parentNodeId ? nodes.get(node.parentNodeId) : undefined;
    while (parent && !parent.invalid) {
      // Lifecycle is local: an inactive intermediary does not retire its descendants.
      if (!parent.archived) ancestors.add(parent.nodeId);
      parent = parent.parentNodeId ? nodes.get(parent.parentNodeId) : undefined;
    }
  }
  return ancestors;
}
/** Any output, whatever its tags, is evidence for goals and Cards. */
export function isOutputNode(data: { type?: unknown }): boolean {
  return data.type === "output";
}
export function goalAncestors(node: CatalogNode, byId: Map<string, CatalogNode>): CatalogNode[] {
  const goals: CatalogNode[] = [];
  let parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
  while (parent) {
    if (
      !parent.invalid &&
      isRequirementNode({ type: parent.type }) &&
      parseFrontmatter(parent.header).data.status !== "draft"
    )
      goals.push(parent);
    parent = parent.parentNodeId ? byId.get(parent.parentNodeId) : undefined;
  }
  return goals;
}
export function syncMaterialIdentity(
  resource: string,
  documentPath: string,
  nodes?: Map<string, CatalogNode>,
  track?: "structure",
): string {
  if (track) return JSON.stringify([track, syncMaterialIdentity(resource, documentPath, nodes)]);
  try {
    const locator = materialLocator(resource, documentPath);
    if (locator.kind === "path" && !isDirectoryMaterial(locator) && nodes) {
      const node = [...nodes.values()].find((n) => nodeNotePath(n.path) === locator.target);
      if (node) return `node:${node.nodeId}${locator.suffix}`;
    }
    if (locator.kind === "uri" && locator.uri.startsWith("file:"))
      return `file-sha256:${createHash("sha256").update(locator.uri).digest("hex")}`;
    return materialIdentity(locator) ?? resource;
  } catch {
    return `unresolved-sha256:${createHash("sha256").update(resource).digest("hex")}`;
  }
}

/** Canonical addresses make structural path rewrites invisible to semantic identity. */
export function nodeSemanticFingerprint(
  data: Record<string, unknown>,
  body: string,
  documentPath = "",
  nodes?: ReadonlyMap<string, Pick<CatalogNode, "nodeId" | "path">>,
  workspaceRoot?: string,
): string {
  return createHash("sha256")
    .update(nodeSemanticContent(data, body, documentPath, nodes, workspaceRoot))
    .digest("hex");
}

/** Canonical semantic bytes shared with the safe filesystem material observer. */
export function nodeSemanticContent(
  data: Record<string, unknown>,
  body: string,
  documentPath = "",
  nodes?: ReadonlyMap<string, Pick<CatalogNode, "nodeId" | "path">>,
  workspaceRoot?: string,
): string {
  const normalizedBody = body.replace(/\r\n?/g, "\n");
  let nodePaths: Map<string, string> | undefined;
  const mapped = new Map<string, string>();
  const canonicalAddress = (resource: string) => {
    if (mapped.has(resource)) return mapped.get(resource)!;
    let value = resource;
    try {
      const locator = materialLocator(resource, documentPath, false);
      if (locator.kind === "path" && !isDirectoryMaterial(locator) && nodes) {
        if (!nodePaths) {
          nodePaths = new Map();
          for (const node of nodes.values()) {
            const file = nodeNotePath(node.path);
            if (!nodePaths.has(file)) nodePaths.set(file, node.nodeId);
          }
        }
        const id = nodePaths.get(locator.target);
        if (id !== undefined) value = `node:${id}${locator.suffix}`;
        else value = materialIdentity(locator) ?? resource;
      } else value = materialIdentity(locator) ?? resource;
    } catch {
      // Invalid addresses retain their original semantic bytes.
    }
    mapped.set(resource, value);
    return value;
  };
  const addresses = materialOccurrences(data)
    .filter(
      ({ resource, field }) =>
        field !== "sources" || !isCardResponseSource(resource, documentPath, workspaceRoot),
    )
    .map(({ resource, track }) =>
      track ? [canonicalAddress(resource), track] : canonicalAddress(resource),
    );
  return cachedSemanticContent(
    () => {
      // Resolve only this body's destinations; unrelated Nodes do not invalidate it.
      if (normalizedBody.includes("[") || normalizedBody.includes("<"))
        for (const { url } of markdownSyntax(normalizedBody).destinations) canonicalAddress(url);
      return [addresses, normalizedBody, [...mapped]];
    },
    () =>
      canonicalJson({
        addresses,
        body: rewriteMarkdownDestinations(normalizedBody, canonicalAddress),
      }),
  );
}
export async function retainedNodeRecords(
  fs: FsAdapter,
): Promise<Record<string, NodeBasisRecord | null>> {
  if (!fs.history || !(await fs.exists(".git"))) return {};
  return fs.history.nodeRecords();
}

/** New records omit retired material metadata; other same-version extensions survive. */
function retainedMaterialBasis({
  repository: _repository,
  directoryFiles: _directoryFiles,
  ...material
}: NodeBasisRecord["materials"][number]) {
  return material;
}

/** A structure edit changes addresses, never acknowledges changed material content. */
export function relocateNodeRecord(
  record: NodeBasisRecord,
  beforeRaw: string,
  beforePath: string,
  afterRaw: string,
  afterPath: string,
  beforeNodes: Map<string, CatalogNode>,
  afterNodes: Map<string, CatalogNode>,
): NodeBasisRecord {
  const before = materialOccurrences(parseFrontmatter(beforeRaw).data),
    after = materialOccurrences(parseFrontmatter(afterRaw).data);
  const mapping = new Map(
    before.map((entry, index) => [
      syncMaterialIdentity(entry.resource, beforePath, beforeNodes, entry.track),
      after[index]
        ? syncMaterialIdentity(after[index]!.resource, afterPath, afterNodes, after[index]!.track)
        : undefined,
    ]),
  );
  return {
    ...record,
    materials: record.materials.map((material) => ({
      ...retainedMaterialBasis(material),
      identity: mapping.get(material.identity) ?? material.identity,
    })),
  };
}

export async function observeSyncMaterial(
  fs: FsAdapter,
  resource: string,
  documentPath: string,
  source = true,
  nodes?: Map<string, CatalogNode>,
  finalDocuments?: Map<string, string>,
  track?: "structure",
  structureResources?: readonly string[],
): Promise<{
  version?: string;
  reason?: string;
  coverage?: true;
  structureDependencies?: string[];
}> {
  try {
    const locator = materialLocator(resource, documentPath, source);
    if (track && !isDirectoryMaterial(locator) && !isPrefixMaterial(locator))
      return { reason: "track: structure requires a directory or prefix material" };
    if (locator.kind === "unresolved") return { reason: "Source is not an explicit local address" };
    if (locator.kind === "uri" && !locator.uri.startsWith("file:"))
      return { reason: "Remote material version is unknown; no network request was made" };
    if (locator.kind === "uri" && !isDirectoryMaterial(locator)) {
      const finalPath = systemMaterialPath(locator, fs.workspaceRoot);
      const finalRaw = finalPath ? finalDocuments?.get(finalPath) : undefined;
      if (
        finalRaw !== undefined &&
        nodes &&
        [...nodes.values()].some((node) => nodeNotePath(node.path) === finalPath)
      ) {
        const uri = new URL(locator.uri);
        const nodeLocator = {
          kind: "path" as const,
          anchor: "bundle" as const,
          target: finalPath!,
          suffix: uri.search + uri.hash,
        };
        return {
          version: nodeMaterialFingerprint(finalRaw, nodeLocator, nodes, fs.workspaceRoot),
        };
      }
    }
    if (!fs.observeMaterial) return { reason: "Material observer is unavailable" };
    const explicitResource =
      locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(resource.trim())
        ? `./${resource.trim()}`
        : resource;
    const observation = await fs.observeMaterial(
      explicitResource,
      documentPath,
      track,
      structureResources,
    );
    const materialNode =
      !isDirectoryMaterial(locator) &&
      observation.systemPath &&
      nodes &&
      [...nodes.values()].find((node) => nodeNotePath(node.path) === observation.systemPath);
    if (materialNode && locator.kind === "uri") {
      const uri = new URL(locator.uri);
      const raw =
        finalDocuments?.get(observation.systemPath!) ??
        (await fs.readFile(observation.systemPath!));
      const nodeLocator = {
        kind: "path" as const,
        anchor: "bundle" as const,
        target: observation.systemPath!,
        suffix: uri.search + uri.hash,
      };
      return {
        version: nodeMaterialFingerprint(raw, nodeLocator, nodes, fs.workspaceRoot),
      };
    }
    return {
      ...(observation.coverage
        ? { coverage: true as const }
        : { version: version.parse(observation.observedVersion) }),
      ...(observation.structureDependencies
        ? { structureDependencies: observation.structureDependencies }
        : {}),
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A read-only catalog inspection shares its path index and material observations. */
export function nodeMaterialObservationScope(nodes: Map<string, CatalogNode>) {
  const nativeNodes = new Map(
    [...nodes.values()]
      .filter((node) => !node.invalid)
      .map((node) => [nodeNotePath(node.path), node]),
  );
  return {
    nativeNodes,
    nodePaths: new Set(nativeNodes.keys()),
    observations: new Map<string, ReturnType<typeof observeSyncMaterial>>(),
  };
}

export async function observeNodeMaterials(
  fs: FsAdapter,
  data: Record<string, unknown>,
  documentPath: string,
  finalDocuments?: Map<string, string>,
  nodes?: Map<string, CatalogNode>,
  scope?: ReturnType<typeof nodeMaterialObservationScope>,
) {
  const directories = new Map<string, ReturnType<typeof observeSyncMaterial>>();
  const occurrences = materialOccurrences(data);
  if (!occurrences.length) return [];
  const structureResources = occurrences
    .filter(({ track }) => track === "structure")
    .map(({ resource }) => resource);
  const structureScope = [
    ...new Set(
      structureResources.map((resource) =>
        syncMaterialIdentity(resource, documentPath, nodes, "structure"),
      ),
    ),
  ].sort();
  const { nativeNodes, nodePaths } = scope ?? (nodes ? nodeMaterialObservationScope(nodes) : {});
  const observations = scope?.observations;
  return Promise.all(
    occurrences
      .filter(
        ({ resource, field }) =>
          field !== "sources" || !isCardResponseSource(resource, documentPath, fs.workspaceRoot),
      )
      .map(async ({ resource, field, track }) => {
        const identity = syncMaterialIdentity(resource, documentPath, nodes, track);
        let observed: {
          version?: string;
          reason?: string;
          coverage?: true;
          structureDependencies?: string[];
        };
        let local = true;
        let coverage = false;
        try {
          const locator = materialLocator(resource, documentPath, field === "sources");
          coverage = !track && (isDirectoryMaterial(locator) || isPrefixMaterial(locator));
          await assertSystemMaterial(fs, locator, nodePaths);
          local =
            locator.kind === "path" || (locator.kind === "uri" && locator.uri.startsWith("file:"));
          const observeOnce = async () => {
            const targetPath = !isDirectoryMaterial(locator)
              ? systemMaterialPath(locator, fs.workspaceRoot)
              : undefined;
            const targetNode = targetPath === undefined ? undefined : nativeNodes?.get(targetPath);
            const finalRaw = targetPath !== undefined ? finalDocuments?.get(targetPath) : undefined;
            const nodeRaw = targetNode ? (finalRaw ?? (await fs.readFile(targetPath!))) : undefined;
            const observe = () =>
              observeSyncMaterial(
                fs,
                resource,
                documentPath,
                field === "sources",
                nodes,
                finalDocuments,
                track,
                track ? structureResources : undefined,
              );
            const directoryKey = identity;
            if (isDirectoryMaterial(locator) && !directories.has(directoryKey))
              directories.set(directoryKey, observe());
            return nodeRaw !== undefined
              ? {
                  version: nodeMaterialFingerprint(nodeRaw, locator, nodes, fs.workspaceRoot),
                }
              : finalRaw === undefined
                ? await (directories.get(directoryKey) ?? observe())
                : {
                    version: createHash("sha256")
                      .update(materialContent(finalRaw, locator).replace(/\r\n?/g, "\n"))
                      .digest("hex"),
                  };
          };
          if (!observations) observed = await observeOnce();
          else {
            // Share current observations across bases, including unavailable addresses.
            const currentKey = JSON.stringify([
              "current",
              identity,
              locator,
              ...(track ? [structureScope] : []),
            ]);
            if (!observations.has(currentKey)) observations.set(currentKey, observeOnce());
            observed = await observations.get(currentKey)!;
          }
        } catch (error) {
          // Existing invalid or unreadable declarations remain editable, with an honest diagnostic.
          observed = { reason: error instanceof Error ? error.message : String(error) };
        }
        return {
          resource,
          ...(track ? { track } : {}),
          identity,
          local,
          ...observed,
          ...(coverage ? { coverage: true as const } : {}),
        };
      }),
  );
}

/** The returned record travels in the SAME capture as these final Node bytes. */
export async function prepareNodeSyncSave(
  fs: FsAdapter,
  documentPath: string,
  raw: string,
  options: {
    confirm?: boolean;
    created?: boolean;
    by?: string;
    now?: string;
    nodes?: Map<string, CatalogNode>;
    previous?: NodeBasisRecord;
    previousRaw?: string;
    records?: Record<string, NodeBasisRecord | null>;
    finalDocuments?: Map<string, string>;
    previousLocation?: { documentPath: string; nodes: Map<string, CatalogNode> };
  } = {},
): Promise<{ raw: string; record?: NodeBasisRecord }> {
  const parsed = parseFrontmatter(raw);
  assertNodeRecordFields(parsed.data);
  if (options.confirm) {
    recordNodeVerification(parsed.data, options.by, options.now);
    raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  }
  const id = parsed.data.id as string;
  const output = isOutputNode(parsed.data);
  const records = options.records ?? (await retainedNodeRecords(fs));
  let previous = options.previous ?? records[id] ?? undefined;
  const nodes = options.nodes ?? (await loadNodeCatalog(fs)).byId;
  if (!previous && !options.created && !options.confirm) {
    if (options.previousRaw === undefined) return { raw };
    const oldMaterials = materialOccurrences(parseFrontmatter(options.previousRaw).data).map(
      ({ resource, track }) => syncMaterialIdentity(resource, documentPath, nodes, track),
    );
    const newlyDeclared = materialOccurrences(parsed.data).some(
      ({ resource, track }) =>
        !oldMaterials.includes(syncMaterialIdentity(resource, documentPath, nodes, track)),
    );
    if (!newlyDeclared) return { raw };
    // An imported Node's old, unknown bases stay unknown when it gains a new declaration.
    previous = { v: 1, materials: oldMaterials.map((identity) => ({ identity })) };
  }
  const finalDocuments = new Map([...(options.finalDocuments ?? []), [documentPath, raw]]);
  const observations = await observeNodeMaterials(
    fs,
    parsed.data,
    documentPath,
    finalDocuments,
    nodes,
  );
  let unavailableLocalBasis = observations.some(
    (observation) => observation.local && !observation.coverage && !observation.version,
  );
  const materials = observations
    .filter((observation) => !observation.coverage)
    .map(({ identity, version, structureDependencies }) => {
      const old = previous?.materials.find((m) => m.identity === identity);
      const useCurrent = (options.confirm && !!version) || !old;
      const known = useCurrent ? (version ?? old?.version) : old?.version;
      const currentAlgorithm = (useCurrent && !!version) || old?.fingerprintVersion === 2;
      return {
        identity,
        ...(known ? { version: known } : {}),
        ...(known && currentAlgorithm ? { fingerprintVersion: 2 as const } : {}),
        ...((useCurrent ? structureDependencies : old?.structureDependencies)
          ? {
              structureDependencies: useCurrent
                ? structureDependencies
                : old?.structureDependencies,
            }
          : {}),
      };
    });
  const node =
    nodes.get(id) ?? [...nodes.values()].find((n) => nodeNotePath(n.path) === documentPath);
  const goals = output && node ? goalAncestors(node, nodes) : [];
  const record: NodeBasisRecord = { v: 1, materials };
  if (previous?.goalBasis) record.goalBasis = previous.goalBasis;
  if (
    (options.created || options.confirm) &&
    isRequirementNode(parsed.data) &&
    (isCoverageGoal(parsed.data, documentPath, fs.workspaceRoot) ||
      coverageGoalAncestors(nodes, fs.workspaceRoot).has(id))
  )
    record.goalBasis = {
      version: nodeSemanticFingerprint(
        parsed.data,
        parsed.body,
        documentPath,
        nodes,
        fs.workspaceRoot,
      ),
      fingerprintVersion: 2,
    };
  if (previous?.goals)
    record.goals = previous.goals.map((goal) => {
      const owner = nodes.get(goal.nodeId);
      const declarations = owner ? materialOccurrences(parseFrontmatter(owner.header).data) : [];
      const coverage = new Set(
        declarations
          .filter(({ resource, track }) => {
            if (track) return false;
            try {
              const locator = materialLocator(resource, nodeNotePath(owner!.path));
              return isDirectoryMaterial(locator) || isPrefixMaterial(locator);
            } catch {
              return false;
            }
          })
          .map(({ resource }) => syncMaterialIdentity(resource, nodeNotePath(owner!.path), nodes)),
      );
      return {
        ...goal,
        materials: goal.materials
          .filter((material) => !coverage.has(material.identity))
          .map(retainedMaterialBasis),
      };
    });
  const firstGoalPlacement =
    options.previousLocation &&
    !previous?.goals &&
    ![...options.previousLocation.nodes.values()].some(
      (ancestor) =>
        options.previousLocation!.documentPath.startsWith(ancestor.path + "/") &&
        !ancestor.invalid &&
        isRequirementNode({ type: ancestor.type }) &&
        parseFrontmatter(ancestor.header).data.status !== "draft",
    );
  if (goals.length && (options.created || options.confirm || firstGoalPlacement)) {
    record.goals = [];
    for (const goal of goals) {
      const goalRaw =
        options.finalDocuments?.get(nodeNotePath(goal.path)) ??
        (await fs.readFile(nodeNotePath(goal.path)));
      const goalParsed = parseFrontmatter(goalRaw);
      const observations = await observeNodeMaterials(
        fs,
        goalParsed.data,
        nodeNotePath(goal.path),
        finalDocuments,
        nodes,
      );
      unavailableLocalBasis ||= observations.some(
        (observation) => observation.local && !observation.coverage && !observation.version,
      );
      const previousMaterials =
        previous?.goals?.find((entry) => entry.nodeId === goal.nodeId)?.materials ?? [];
      record.goals.push({
        nodeId: goal.nodeId,
        fingerprintVersion: 2,
        version: nodeSemanticFingerprint(
          goalParsed.data,
          goalParsed.body,
          nodeNotePath(goal.path),
          nodes,
          fs.workspaceRoot,
        ),
        materials: observations
          .filter((observation) => !observation.coverage)
          .map(({ identity, version, structureDependencies }) =>
            version
              ? {
                  identity,
                  version,
                  fingerprintVersion: 2 as const,
                  ...(structureDependencies ? { structureDependencies } : {}),
                }
              : retainedMaterialBasis(
                  previousMaterials.find((entry) => entry.identity === identity) ?? { identity },
                ),
          ),
      });
    }
  }
  return output && !previous && !options.created && unavailableLocalBasis
    ? { raw }
    : { raw, record };
}

/** Node material addresses use the same semantic basis as implicit goal dependencies. */
export function nodeMaterialFingerprint(
  raw: string,
  locator: ReturnType<typeof materialLocator>,
  nodes?: Map<string, CatalogNode>,
  workspaceRoot?: string,
): string {
  const parsed = parseFrontmatter(raw);
  return nodeSemanticFingerprint(
    parsed.data,
    markdownMaterialHeading(locator) === undefined ? parsed.body : materialContent(raw, locator),
    systemMaterialPath(locator, workspaceRoot) ?? "",
    nodes,
    workspaceRoot,
  );
}
