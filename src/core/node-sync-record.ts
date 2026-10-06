import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";
import { canonicalSha256, canonicalJson } from "./canonical-digest.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  materialIdentity,
  materialLocator,
  materialOccurrences,
  isCardResponseSource,
} from "./material.js";
import { materialContent, markdownMaterialHeading } from "./material-section.js";
import { nodeTypePrimary } from "./node-type.js";
import { recordNodeVerification } from "./node-provenance.js";
import { loadNodeCatalog, type CatalogNode } from "./node-catalog.js";
import { nodeNotePath } from "./paths.js";
import { rewriteMarkdownDestinations } from "../markdown/links.js";
import { createHash } from "node:crypto";
import {
  legacyTextVersions,
  retainedSemanticVersions,
  reinterpretNodeBasisRecords,
} from "./node-semantic-history.js";

import type { NodeBasisRecord } from "./node-basis-record.js";
import type { RepositoryMaterial } from "./repository-material.js";
export { nodeBasisRecordSchema, type NodeBasisRecord } from "./node-basis-record.js";
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
      throw new Error(`Node field ${field} is retired; migrate legacy Node records first`);
  if (Array.isArray(data.sources))
    for (const source of data.sources)
      if (source.sha256 !== undefined || source.resource_sha256 !== undefined)
        throw new Error("Material hashes belong to the Git record layer, not Node sources");
}

export function isRequirementNode(data: Record<string, unknown>): boolean {
  return typeof data.type === "string" && nodeTypePrimary(data.type) === "goal";
}
export function isOutputNode(data: { type?: unknown }): boolean {
  return typeof data.type === "string" && nodeTypePrimary(data.type) === "output";
}
export function isImplementationOutputNode(data: { type?: unknown }): boolean {
  return data.type === "output-asset" || data.type === "output-evidence";
}
export function nearestGoal(
  node: CatalogNode,
  byId: Map<string, CatalogNode>,
): CatalogNode | undefined {
  return goalAncestors(node, byId)[0];
}
export function goalAncestors(node: CatalogNode, byId: Map<string, CatalogNode>): CatalogNode[] {
  const goals: CatalogNode[] = [];
  let parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
  while (parent) {
    if (
      !parent.archived &&
      !parent.invalid &&
      parseFrontmatter(parent.header).data.status !== "deprecated" &&
      isRequirementNode({ type: parent.type })
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
) {
  try {
    const locator = materialLocator(resource, documentPath);
    if (locator.kind === "path" && nodes) {
      const node = [...nodes.values()].find((n) => nodeNotePath(n.path) === locator.target);
      if (node) return `node:${node.nodeId}${locator.suffix}`;
    }
    return materialIdentity(locator) ?? resource;
  } catch {
    return resource;
  }
}

/** Canonical addresses make structural path rewrites invisible to semantic identity. */
export function nodeSemanticFingerprint(
  data: Record<string, unknown>,
  body: string,
  documentPath = "",
  nodes?: Map<string, CatalogNode>,
): string {
  return createHash("sha256")
    .update(nodeSemanticContent(data, body, documentPath, nodes))
    .digest("hex");
}

/** Canonical semantic bytes shared with the safe filesystem material observer. */
export function nodeSemanticContent(
  data: Record<string, unknown>,
  body: string,
  documentPath = "",
  nodes?: Map<string, CatalogNode>,
): string {
  const canonicalAddress = (resource: string) => {
    try {
      const locator = materialLocator(resource, documentPath, false);
      if (locator.kind === "path") {
        const node =
          nodes && [...nodes.values()].find((n) => nodeNotePath(n.path) === locator.target);
        if (node) return `node:${node.nodeId}${locator.suffix}`;
      }
      return materialIdentity(locator) ?? resource;
    } catch {
      return resource;
    }
  };
  return canonicalJson({
    addresses: materialOccurrences(data)
      .filter(
        ({ resource, field }) =>
          field !== "sources" || !isCardResponseSource(resource, documentPath),
      )
      .map(({ resource }) => canonicalAddress(resource)),
    body: rewriteMarkdownDestinations(body.replace(/\r\n?/g, "\n"), canonicalAddress),
  });
}

export async function retainedNodeRecords(fs: FsAdapter): Promise<Record<string, NodeBasisRecord>> {
  if (!fs.history || !(await fs.exists(".git"))) return {};
  const records = await fs.history.nodeRecords();
  if (
    !Object.values(records).some(
      (record) =>
        (record.goal?.fingerprintVersion !== 2 && !!record.goal) ||
        record.materials.some((material) => material.version && material.fingerprintVersion !== 2),
    )
  )
    return records;
  return reinterpretNodeBasisRecords(records, await retainedSemanticVersions(fs.history));
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
      syncMaterialIdentity(entry.resource, beforePath, beforeNodes),
      after[index]
        ? syncMaterialIdentity(after[index]!.resource, afterPath, afterNodes)
        : undefined,
    ]),
  );
  return {
    ...record,
    materials: record.materials.map((material) => ({
      ...material,
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
  repository?: RepositoryMaterial,
): Promise<{
  version?: string;
  reason?: string;
  legacyVersions?: string[];
  repository?: RepositoryMaterial;
}> {
  try {
    const locator = materialLocator(resource, documentPath, source);
    if (locator.kind === "unresolved") return { reason: "Source is not an explicit local address" };
    if (locator.kind === "uri" && !locator.uri.startsWith("file:"))
      return { reason: "Remote material version is unknown; no network request was made" };
    if (locator.kind === "uri") {
      const finalPath = fs.history?.localFileUriDocumentPath(locator.uri);
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
          version: nodeMaterialFingerprint(finalRaw, nodeLocator, nodes),
          legacyVersions: legacyTextVersions(materialContent(finalRaw, nodeLocator)),
        };
      }
    }
    if (!fs.observeMaterial) return { reason: "Material observer is unavailable" };
    const explicitResource =
      locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(resource.trim())
        ? `./${resource.trim()}`
        : resource;
    const observation = await fs.observeMaterial(explicitResource, documentPath, repository);
    const materialNode =
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
        version: nodeMaterialFingerprint(raw, nodeLocator, nodes),
        legacyVersions: legacyTextVersions(materialContent(raw, nodeLocator)),
      };
    }
    return {
      version: version.parse(observation.observedVersion),
      ...(observation.legacyVersions ? { legacyVersions: observation.legacyVersions } : {}),
      ...(observation.repository ? { repository: observation.repository } : {}),
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function observeNodeMaterials(
  fs: FsAdapter,
  data: Record<string, unknown>,
  documentPath: string,
  finalDocuments?: Map<string, string>,
  nodes?: Map<string, CatalogNode>,
  previous?: NodeBasisRecord,
) {
  return Promise.all(
    materialOccurrences(data)
      .filter(
        ({ resource, field }) =>
          field !== "sources" || !isCardResponseSource(resource, documentPath),
      )
      .map(async ({ resource, field }) => {
        const identity = syncMaterialIdentity(resource, documentPath, nodes);
        const repository = previous?.materials.find(
          (material) => material.identity === identity,
        )?.repository;
        let observed: {
          version?: string;
          reason?: string;
          legacyVersions?: string[];
          repository?: RepositoryMaterial;
        };
        try {
          const locator = materialLocator(resource, documentPath, field === "sources");
          const targetNode =
            locator.kind === "path" && nodes
              ? [...nodes.values()].find((node) => nodeNotePath(node.path) === locator.target)
              : undefined;
          const finalRaw =
            locator.kind === "path" ? finalDocuments?.get(locator.target) : undefined;
          const nodeRaw =
            targetNode && locator.kind === "path"
              ? (finalRaw ?? (await fs.readFile(locator.target)))
              : undefined;
          observed =
            nodeRaw !== undefined
              ? {
                  version: nodeMaterialFingerprint(nodeRaw, locator, nodes),
                  legacyVersions: legacyTextVersions(materialContent(nodeRaw, locator)),
                }
              : finalRaw === undefined
                ? await observeSyncMaterial(
                    fs,
                    resource,
                    documentPath,
                    field === "sources",
                    nodes,
                    finalDocuments,
                    repository,
                  )
                : {
                    legacyVersions: legacyTextVersions(materialContent(finalRaw, locator)),
                    version: createHash("sha256")
                      .update(materialContent(finalRaw, locator).replace(/\r\n?/g, "\n"))
                      .digest("hex"),
                  };
        } catch (error) {
          // Existing invalid or unreadable declarations remain editable, with an honest diagnostic.
          observed = { reason: error instanceof Error ? error.message : String(error) };
        }
        return {
          resource,
          identity,
          ...observed,
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
    acknowledge?: boolean;
    created?: boolean;
    by?: string;
    now?: string;
    nodes?: Map<string, CatalogNode>;
    previous?: NodeBasisRecord;
    records?: Record<string, NodeBasisRecord>;
    finalDocuments?: Map<string, string>;
    previousLocation?: { documentPath: string; nodes: Map<string, CatalogNode> };
  } = {},
): Promise<{ raw: string; record: NodeBasisRecord }> {
  const parsed = parseFrontmatter(raw);
  assertNodeRecordFields(parsed.data);
  if (options.confirm) {
    recordNodeVerification(parsed.data, options.by, options.now);
    raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  }
  const id = parsed.data.id as string;
  const records = options.records ?? (await retainedNodeRecords(fs));
  const previous = options.previous ?? records[id];
  const nodes = options.nodes ?? (await loadNodeCatalog(fs)).byId;
  const finalDocuments = new Map([...(options.finalDocuments ?? []), [documentPath, raw]]);
  const observations = await observeNodeMaterials(
    fs,
    parsed.data,
    documentPath,
    finalDocuments,
    nodes,
    previous,
  );
  const materials = observations.map(({ identity, version, legacyVersions, repository }) => {
    const old = previous?.materials.find((m) => m.identity === identity);
    const equivalentLegacy =
      old?.fingerprintVersion !== 2 &&
      !!old?.version &&
      (old.version === version || legacyVersions?.includes(old.version));
    const useCurrent =
      ((options.confirm || options.acknowledge) && !!version) || !old || equivalentLegacy;
    const known = useCurrent ? (version ?? old?.version) : old?.version;
    const currentAlgorithm = (useCurrent && !!version) || old?.fingerprintVersion === 2;
    const materialRepository = useCurrent
      ? version
        ? repository
        : old?.repository
      : (old?.repository ?? (version === known ? repository : undefined));
    return {
      identity,
      ...(known ? { version: known } : {}),
      ...(known && currentAlgorithm ? { fingerprintVersion: 2 as const } : {}),
      ...(materialRepository ? { repository: materialRepository } : {}),
    };
  });
  const node =
    nodes.get(id) ?? [...nodes.values()].find((n) => nodeNotePath(n.path) === documentPath);
  const goals = isOutputNode(parsed.data) && node ? goalAncestors(node, nodes) : [];
  const record: NodeBasisRecord = { materials };
  if (previous?.materialsRevision) record.materialsRevision = previous.materialsRevision;
  if (
    options.confirm &&
    isRequirementNode(parsed.data) &&
    previous &&
    materials.some((material) => {
      const old = previous.materials.find((entry) => entry.identity === material.identity);
      const observation = observations.find((entry) => entry.identity === material.identity);
      return (
        old?.version &&
        material.version &&
        old.version !== material.version &&
        !(old.fingerprintVersion !== 2 && observation?.legacyVersions?.includes(old.version))
      );
    })
  )
    record.materialsRevision = canonicalSha256({ previous: previous.materialsRevision, materials });
  if (previous?.goal && !options.confirm && !options.acknowledge) record.goal = previous.goal;
  if (previous?.goals) record.goals = previous.goals;
  const firstGoalPlacement =
    options.previousLocation &&
    !previous?.goal &&
    !previous?.goals &&
    ![...options.previousLocation.nodes.values()].some(
      (ancestor) =>
        options.previousLocation!.documentPath.startsWith(ancestor.path + "/") &&
        !ancestor.archived &&
        !ancestor.invalid &&
        parseFrontmatter(ancestor.header).data.status !== "deprecated" &&
        isRequirementNode({ type: ancestor.type }),
    );
  if (
    goals.length &&
    (options.created || options.confirm || options.acknowledge || firstGoalPlacement)
  ) {
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
        {
          materials:
            previous?.goals?.find((entry) => entry.nodeId === goal.nodeId)?.materials ?? [],
        },
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
        ),
        materials: observations.map(({ identity, version, repository }) =>
          version
            ? {
                identity,
                version,
                fingerprintVersion: 2 as const,
                ...(repository ? { repository } : {}),
              }
            : (previousMaterials.find((entry) => entry.identity === identity) ?? { identity }),
        ),
      });
    }
  }
  return { raw, record };
}

/** Node material addresses use the same semantic basis as implicit goal dependencies. */
export function nodeMaterialFingerprint(
  raw: string,
  locator: ReturnType<typeof materialLocator>,
  nodes?: Map<string, CatalogNode>,
): string {
  const parsed = parseFrontmatter(raw);
  return nodeSemanticFingerprint(
    parsed.data,
    markdownMaterialHeading(locator) === undefined ? parsed.body : materialContent(raw, locator),
    locator.kind === "path" ? locator.target : "",
    nodes,
  );
}
