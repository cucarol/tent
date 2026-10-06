import { createHash } from "node:crypto";
import type { GitDocumentHistory } from "./git-history.js";
import type { NodeBasisRecord } from "./node-basis-record.js";
import type { CatalogNode } from "./node-catalog.js";
import { parseFrontmatter } from "./frontmatter.js";
import { materialContent } from "./material-section.js";
import { materialIdentity, materialLocator } from "./material.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { nodeNotePath } from "./paths.js";
import { rewriteMarkdownDestinations } from "../markdown/links.js";
import { isNodeId } from "./id.js";
import {
  nodeMaterialFingerprint,
  nodeSemanticFingerprint,
  retiredNodeFields,
} from "./node-sync-record.js";

export function legacyTextVersions(raw: string): string[] {
  const normalized = raw.replace(/\r\n?/g, "\n");
  return [
    ...new Set([
      raw,
      normalized,
      normalized.replace(/\n/g, "\r\n"),
      normalized.replace(/\n/g, "\r"),
    ]),
  ].map((text) => createHash("sha256").update(text).digest("hex"));
}

type Documents = Map<string, { path: string; raw: string }>;
export function historicalNodeCatalog(documents: Documents): Map<string, CatalogNode> {
  const nodes = new Map<string, CatalogNode>();
  for (const [nodeId, document] of documents) {
    let parsed;
    try {
      parsed = parseFrontmatter(document.raw);
    } catch {
      continue;
    }
    nodes.set(nodeId, {
      nodeId,
      path: document.path,
      name: document.path.split("/").at(-1)!,
      type: typeof parsed.data.type === "string" ? parsed.data.type : undefined,
      header: document.raw.slice(0, document.raw.length - parsed.body.length),
      parentNodeId: null,
      childNodeIds: [],
      archived: parsed.data.status === "deprecated",
      invalid: false,
    });
  }
  const byPath = new Map([...nodes.values()].map((node) => [node.path, node]));
  for (const node of nodes.values()) {
    const parentPath = node.path.includes("/")
      ? node.path.slice(0, node.path.lastIndexOf("/"))
      : undefined;
    node.parentNodeId = parentPath ? (byPath.get(parentPath)?.nodeId ?? null) : null;
  }
  return nodes;
}

function legacyGoalFingerprint(raw: string, documentPath: string, nodes: Map<string, CatalogNode>) {
  const parsed = parseFrontmatter(raw);
  const address = (resource: string) => {
    try {
      const locator = materialLocator(resource, documentPath, false);
      if (locator.kind === "path") {
        const node = [...nodes.values()].find((node) => nodeNotePath(node.path) === locator.target);
        if (node) return `node:${node.nodeId}${locator.suffix}`;
      }
      return materialIdentity(locator) ?? resource;
    } catch {
      return resource;
    }
  };
  const data = { ...parsed.data };
  for (const key of [
    "id",
    "title",
    "generated",
    "verified",
    "stale_after",
    "status",
    ...retiredNodeFields,
  ])
    delete data[key];
  if (typeof data.resource === "string") data.resource = address(data.resource);
  if (Array.isArray(data.sources))
    data.sources = data.sources.map((source) => ({
      ...source,
      resource: address(source.resource),
    }));
  return canonicalSha256({ data, body: rewriteMarkdownDestinations(parsed.body, address) });
}

type SemanticIndex = {
  goals: Record<string, Record<string, string>>;
  materials: Record<string, Record<string, string>>;
};
/** Only retained bytes can reinterpret an earlier Node baseline; no live material is read. */
export function retainedSemanticVersions(history: GitDocumentHistory): Promise<SemanticIndex> {
  return history.derived("semantic-basis-versions", 2, async () => {
    const events = await history.changesInRange();
    const recordEvents = await history.nodeRecordEvents();
    const reads = await history.readVersions(
      events.flatMap((event) =>
        event.changes.flatMap((change) => (change.after ? [change.after] : [])),
      ),
    );
    const rawByVersion = new Map<string, string>();
    for (const read of reads) {
      if (read instanceof Error) throw read;
      rawByVersion.set(`${read.version.commit}:${read.version.path}`, read.raw);
    }
    const goalHashes = new Map<string, Set<string>>();
    const materialHashes = new Map<string, Set<string>>();
    const acquired = new Map<string, number>();
    events.forEach((event, index) => {
      for (const record of Object.values(recordEvents[event.commit] ?? {})) {
        if (record.goal && !acquired.has(`goal:${record.goal.nodeId}:${record.goal.version}`))
          acquired.set(`goal:${record.goal.nodeId}:${record.goal.version}`, index);
        for (const material of record.materials)
          if (
            material.version &&
            !acquired.has(`material:${material.identity}:${material.version}`)
          )
            acquired.set(`material:${material.identity}:${material.version}`, index);
      }
    });
    for (const records of Object.values(recordEvents))
      for (const record of Object.values(records)) {
        if (record.goal && record.goal.fingerprintVersion !== 2) {
          const hashes = goalHashes.get(record.goal.nodeId) ?? new Set<string>();
          hashes.add(record.goal.version);
          goalHashes.set(record.goal.nodeId, hashes);
        }
        for (const material of record.materials)
          if (material.version && material.fingerprintVersion !== 2) {
            const hashes = materialHashes.get(material.identity) ?? new Set<string>();
            hashes.add(material.version);
            materialHashes.set(material.identity, hashes);
          }
      }
    const result: SemanticIndex = { goals: {}, materials: {} };
    const documents: Documents = new Map();
    for (const [eventIndex, event] of events.entries()) {
      for (const change of event.changes) {
        if (!change.objectId || !isNodeId(change.objectId)) continue;
        if (change.after) {
          const raw = rawByVersion.get(`${change.after.commit}:${change.after.path}`);
          if (raw !== undefined)
            documents.set(change.objectId, {
              path: change.after.path.replace(/\/[^/]+$/, ""),
              raw,
            });
        } else documents.delete(change.objectId);
      }
      const nodes = historicalNodeCatalog(documents);
      for (const [nodeId, hashes] of goalHashes) {
        const document = documents.get(nodeId);
        if (!document || !nodes.has(nodeId)) continue;
        const old = legacyGoalFingerprint(document.raw, nodeNotePath(document.path), nodes);
        if (hashes.has(old) && eventIndex <= acquired.get(`goal:${nodeId}:${old}`)!) {
          const parsed = parseFrontmatter(document.raw);
          (result.goals[nodeId] ??= {})[old] = nodeSemanticFingerprint(
            parsed.data,
            parsed.body,
            nodeNotePath(document.path),
            nodes,
          );
        }
      }
      for (const [identity, hashes] of materialHashes) {
        let nodeId: string | undefined,
          suffix = "";
        if (identity.startsWith("node:")) {
          const match = /^node:(node-[^?#]+)(.*)$/.exec(identity);
          nodeId = match?.[1];
          suffix = match?.[2] ?? "";
        } else {
          try {
            const [kind, target, fragment] = JSON.parse(identity);
            if (kind === "path") {
              nodeId = [...nodes.values()].find(
                (node) => nodeNotePath(node.path) === target,
              )?.nodeId;
              suffix = fragment ?? "";
            } else if (kind === "uri" && target.startsWith("file:")) {
              const uri = new URL(target),
                documentPath = history.localFileUriDocumentPath(target);
              nodeId =
                documentPath &&
                [...nodes.values()].find((node) => nodeNotePath(node.path) === documentPath)
                  ?.nodeId;
              suffix = uri.search + uri.hash;
            }
          } catch {
            continue;
          }
        }
        const document = nodeId && documents.get(nodeId);
        if (!document || !nodes.has(nodeId!)) continue;
        const locator = {
          kind: "path" as const,
          anchor: "bundle" as const,
          target: nodeNotePath(document.path),
          suffix,
        };
        try {
          for (const old of legacyTextVersions(materialContent(document.raw, locator)))
            if (hashes.has(old) && eventIndex <= acquired.get(`material:${identity}:${old}`)!)
              (result.materials[identity] ??= {})[old] = nodeMaterialFingerprint(
                document.raw,
                locator,
                nodes,
              );
        } catch {
          /* An unavailable historical section never supplies a replacement baseline. */
        }
      }
    }
    return result;
  });
}

export function reinterpretNodeBasisRecords(
  records: Record<string, NodeBasisRecord>,
  index: SemanticIndex,
): Record<string, NodeBasisRecord> {
  return Object.fromEntries(
    Object.entries(records).map(([id, record]) => {
      const result = structuredClone(record);
      if (result.goal && result.goal.fingerprintVersion !== 2) {
        const version = index.goals[result.goal.nodeId]?.[result.goal.version];
        if (version) result.goal = { ...result.goal, version, fingerprintVersion: 2 };
      }
      result.materials = result.materials.map((material) => {
        const version =
          material.version &&
          material.fingerprintVersion !== 2 &&
          index.materials[material.identity]?.[material.version];
        return version ? { ...material, version, fingerprintVersion: 2 } : material;
      });
      return [id, result];
    }),
  );
}
