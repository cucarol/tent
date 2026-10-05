import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { materialIdentity, materialLocator, materialOccurrences } from "./material.js";
import { materialContent } from "./material-section.js";
import { nodeTypePrimary } from "./node-type.js";
import { recordNodeVerification } from "./node-provenance.js";
import { loadNodeCatalog, type CatalogNode } from "./node-catalog.js";
import { nodeNotePath } from "./paths.js";
import { rewriteMarkdownDestinations } from "../markdown/links.js";
import { createHash } from "node:crypto";

import type { NodeBasisRecord } from "./node-basis-record.js";
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
export function nearestGoal(
  node: CatalogNode,
  byId: Map<string, CatalogNode>,
): CatalogNode | undefined {
  let parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
  while (parent) {
    if (
      !parent.archived &&
      !parent.invalid &&
      parseFrontmatter(parent.header).data.status !== "deprecated" &&
      isRequirementNode({ type: parent.type })
    )
      return parent;
    parent = parent.parentNodeId ? byId.get(parent.parentNodeId) : undefined;
  }
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
  const semantic = { ...data };
  for (const key of [
    "id",
    "title",
    "generated",
    "verified",
    "stale_after",
    "status",
    ...retiredNodeFields,
  ])
    delete semantic[key];
  if (typeof semantic.resource === "string")
    semantic.resource = canonicalAddress(semantic.resource);
  if (Array.isArray(semantic.sources))
    semantic.sources = semantic.sources.map((source) => ({
      ...source,
      resource: canonicalAddress(source.resource),
    }));
  return canonicalSha256({
    data: semantic,
    body: rewriteMarkdownDestinations(body, canonicalAddress),
  });
}

export async function retainedNodeRecords(fs: FsAdapter): Promise<Record<string, NodeBasisRecord>> {
  return fs.history && (await fs.exists(".git")) ? fs.history.nodeRecords() : {};
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
): Promise<{ version?: string; reason?: string }> {
  try {
    const locator = materialLocator(resource, documentPath, source);
    if (locator.kind === "unresolved") return { reason: "Source is not an explicit local address" };
    if (locator.kind === "uri" && !locator.uri.startsWith("file:"))
      return { reason: "Remote material version is unknown; no network request was made" };
    if (!fs.observeMaterial) return { reason: "Material observer is unavailable" };
    const explicitResource =
      locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(resource.trim())
        ? `./${resource.trim()}`
        : resource;
    return {
      version: version.parse(
        (await fs.observeMaterial(explicitResource, documentPath)).observedVersion,
      ),
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
) {
  return Promise.all(
    materialOccurrences(data).map(async ({ resource, field }) => {
      let observed: { version?: string; reason?: string };
      try {
        const locator = materialLocator(resource, documentPath, field === "sources");
        const finalRaw = locator.kind === "path" ? finalDocuments?.get(locator.target) : undefined;
        observed =
          finalRaw === undefined
            ? await observeSyncMaterial(fs, resource, documentPath, field === "sources")
            : {
                version: createHash("sha256")
                  .update(materialContent(finalRaw, locator))
                  .digest("hex"),
              };
      } catch (error) {
        // Existing invalid or unreadable declarations remain editable, with an honest diagnostic.
        observed = { reason: error instanceof Error ? error.message : String(error) };
      }
      return {
        resource,
        identity: syncMaterialIdentity(resource, documentPath, nodes),
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
    by?: string;
    now?: string;
    nodes?: Map<string, CatalogNode>;
    previous?: NodeBasisRecord;
    finalDocuments?: Map<string, string>;
  } = {},
): Promise<{ raw: string; record: NodeBasisRecord }> {
  const parsed = parseFrontmatter(raw);
  assertNodeRecordFields(parsed.data);
  if (options.confirm) {
    recordNodeVerification(parsed.data, options.by, options.now);
    raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  }
  const id = parsed.data.id as string;
  const previous = options.previous ?? (await retainedNodeRecords(fs))[id];
  const nodes = options.nodes ?? (await loadNodeCatalog(fs)).byId;
  const observations = await observeNodeMaterials(
    fs,
    parsed.data,
    documentPath,
    new Map([...(options.finalDocuments ?? []), [documentPath, raw]]),
    nodes,
  );
  const materials = observations.map(({ identity, version }) => {
    const old = previous?.materials.find((m) => m.identity === identity);
    const known = options.confirm ? (version ?? old?.version) : old ? old.version : version;
    return { identity, ...(known ? { version: known } : {}) };
  });
  const node =
    nodes.get(id) ?? [...nodes.values()].find((n) => nodeNotePath(n.path) === documentPath);
  const goal = isOutputNode(parsed.data) && node ? nearestGoal(node, nodes) : undefined;
  const record: NodeBasisRecord = { materials };
  if (goal) {
    const goalRaw =
      options.finalDocuments?.get(nodeNotePath(goal.path)) ??
      (await fs.readFile(nodeNotePath(goal.path)));
    const goalParsed = parseFrontmatter(goalRaw);
    record.goal =
      !options.confirm && previous?.goal?.nodeId === goal.nodeId
        ? previous.goal
        : {
            nodeId: goal.nodeId,
            version: nodeSemanticFingerprint(
              goalParsed.data,
              goalParsed.body,
              nodeNotePath(goal.path),
              nodes,
            ),
          };
  }
  return { raw, record };
}
