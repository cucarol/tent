import { createHash } from "node:crypto";
import type { GitDocumentHistory } from "./git-history.js";
import type { NodeBasisRecord } from "./node-basis-record.js";
import type { CatalogNode } from "./node-catalog.js";
import { parseFrontmatter, type ParsedFrontmatter } from "./frontmatter.js";
import { materialContent } from "./material-section.js";
import { materialIdentity, materialLocator } from "./material.js";
import { canonicalSha256, canonicalJson } from "./canonical-digest.js";
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
/** Immutable retained bytes need parsing only once during one history query. */
export function historicalFrontmatterReader(): typeof parseFrontmatter {
  const parsed = new Map<string, ParsedFrontmatter | Error>();
  return (raw) => {
    let value = parsed.get(raw);
    if (!value) {
      try {
        value = parseFrontmatter(raw);
      } catch (error) {
        value = error instanceof Error ? error : new Error(String(error));
      }
      parsed.set(raw, value);
    }
    if (value instanceof Error) throw value;
    return value;
  };
}

export function historicalNodeCatalog(
  documents: Documents,
  readFrontmatter = parseFrontmatter,
): Map<string, CatalogNode> {
  const nodes = new Map<string, CatalogNode>();
  for (const [nodeId, document] of documents) {
    let parsed;
    try {
      parsed = readFrontmatter(document.raw);
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

/** Reuse fingerprints while the addresses actually referenced by these bytes still resolve alike. */
export function historicalFingerprintReader<T>(readFrontmatter: typeof parseFrontmatter) {
  const resourcesByRaw = new Map<string, string[]>();
  const resourcesByBody = new Map<string, string[]>();
  const values = new Map<string, Map<string, { addresses: unknown[]; value: T }>>();
  const pathsByCatalog = new WeakMap<Map<string, CatalogNode>, Map<string, string>>();
  return (
    raw: string,
    documentPath: string,
    nodes: Map<string, CatalogNode>,
    compute: (parsed: ParsedFrontmatter) => T,
    selection = "",
  ): T => {
    const parsed = readFrontmatter(raw);
    let resources = resourcesByRaw.get(raw);
    if (!resources) {
      const selected = new Set<string>();
      if (typeof parsed.data.resource === "string") selected.add(parsed.data.resource);
      if (Array.isArray(parsed.data.sources))
        for (const source of parsed.data.sources)
          if (typeof source?.resource === "string") selected.add(source.resource);
      let bodyResources = resourcesByBody.get(parsed.body);
      if (!bodyResources) {
        const destinations = new Set<string>();
        rewriteMarkdownDestinations(parsed.body, (resource) => {
          destinations.add(resource);
          return resource;
        });
        bodyResources = [...destinations];
        resourcesByBody.set(parsed.body, bodyResources);
      }
      for (const resource of bodyResources) selected.add(resource);
      resources = [...selected];
      resourcesByRaw.set(raw, resources);
    }
    let paths = pathsByCatalog.get(nodes);
    if (!paths) {
      paths = new Map();
      for (const node of nodes.values()) {
        const notePath = nodeNotePath(node.path);
        if (!paths.has(notePath)) paths.set(notePath, node.nodeId);
      }
      pathsByCatalog.set(nodes, paths);
    }
    const addresses = resources.map((resource) => {
      try {
        const locator = materialLocator(resource, documentPath, false);
        if (locator.kind === "path") {
          const nodeId = paths.get(locator.target);
          if (nodeId) return `node:${nodeId}${locator.suffix}`;
        }
        return materialIdentity(locator) ?? resource;
      } catch {
        return resource;
      }
    });
    const versions = values.get(raw) ?? new Map();
    values.set(raw, versions);
    const key = JSON.stringify([documentPath, selection]);
    let previous = versions.get(key);
    if (!previous || addresses.some((address, index) => address !== previous!.addresses[index])) {
      previous = { addresses, value: compute(parsed) };
      versions.set(key, previous);
    }
    return previous.value;
  };
}

function legacyGoalData(parsed: ParsedFrontmatter) {
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
  return data;
}

function legacyGoalFingerprint(
  parsed: ParsedFrontmatter,
  documentPath: string,
  nodes: Map<string, CatalogNode>,
) {
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
  const data = legacyGoalData(parsed);
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
    const retainedPaths = new Set(
      events.flatMap((event) =>
        event.changes.flatMap((change) =>
          change.objectId && isNodeId(change.objectId) && change.after
            ? [nodeNotePath(change.after.path.replace(/\/[^/]+$/, ""))]
            : [],
        ),
      ),
    );
    const materialReceipts = [...materialHashes].flatMap(([identity, hashes]) => {
      let nodeId: string | undefined,
        target: string | undefined,
        suffix = "";
      if (identity.startsWith("node:")) {
        const match = /^node:(node-[^?#]+)(.*)$/.exec(identity);
        nodeId = match?.[1];
        suffix = match?.[2] ?? "";
      } else {
        try {
          const [kind, path, fragment] = JSON.parse(identity);
          if (kind === "path") {
            target = path;
            suffix = fragment ?? "";
          } else if (kind === "uri" && path.startsWith("file:")) {
            target = history.localFileUriDocumentPath(path);
            const uri = new URL(path);
            suffix = uri.search + uri.hash;
          }
        } catch {
          return [];
        }
      }
      // Retained Node bytes can never establish a baseline for an external material.
      if (!nodeId && (!target || !retainedPaths.has(target))) return [];
      return [{ identity, hashes, nodeId, target, suffix }];
    });
    // Bytes acquired after every relevant legacy receipt cannot supply its basis.
    let lastAcquisition = -1;
    for (const [nodeId, hashes] of goalHashes)
      for (const hash of hashes)
        lastAcquisition = Math.max(lastAcquisition, acquired.get(`goal:${nodeId}:${hash}`)!);
    for (const { identity, hashes } of materialReceipts)
      for (const hash of hashes)
        lastAcquisition = Math.max(lastAcquisition, acquired.get(`material:${identity}:${hash}`)!);
    const relevantEvents = events.slice(0, lastAcquisition + 1);
    const reads = await history.readVersions(
      relevantEvents.flatMap((event) =>
        event.changes.flatMap((change) => (change.after ? [change.after] : [])),
      ),
    );
    const rawByVersion = new Map<string, string>();
    for (const read of reads) {
      if (read instanceof Error) throw read;
      rawByVersion.set(`${read.version.commit}:${read.version.path}`, read.raw);
    }
    const documents: Documents = new Map();
    const readFrontmatter = historicalFrontmatterReader();
    const legacyGoals = new Map<string, ParsedFrontmatter>();
    const goalKeys = new Map<string, string>();
    const goalVersion = historicalFingerprintReader<{ old: string; current?: string }>((key) =>
      legacyGoals.get(key)!,
    );
    const materialVersion = historicalFingerprintReader<string>(readFrontmatter);
    const materialHashesByRaw = new Map<string, Map<string, string[]>>();
    for (const [eventIndex, event] of relevantEvents.entries()) {
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
      const nodes = historicalNodeCatalog(documents, readFrontmatter);
      for (const [nodeId, hashes] of goalHashes) {
        if (![...hashes].some((hash) => eventIndex <= acquired.get(`goal:${nodeId}:${hash}`)!))
          continue;
        const document = documents.get(nodeId);
        if (!document || !nodes.has(nodeId)) continue;
        const parsed = readFrontmatter(document.raw);
        let key = goalKeys.get(document.raw);
        if (!key) {
          const semantic = { ...parsed, data: legacyGoalData(parsed) };
          key = canonicalJson({ data: semantic.data, body: semantic.body });
          goalKeys.set(document.raw, key);
          legacyGoals.set(key, semantic);
        }
        const version = goalVersion(key, nodeNotePath(document.path), nodes, (parsed) => ({
          old: legacyGoalFingerprint(parsed, nodeNotePath(document.path), nodes),
        }));
        const old = version.old;
        if (hashes.has(old) && eventIndex <= acquired.get(`goal:${nodeId}:${old}`)!) {
          version.current ??= nodeSemanticFingerprint(
            parsed.data,
            parsed.body,
            nodeNotePath(document.path),
            nodes,
          );
          (result.goals[nodeId] ??= {})[old] = version.current;
        }
      }
      for (const receipt of materialReceipts) {
        const { identity, hashes, suffix } = receipt;
        if (
          ![...hashes].some((hash) => eventIndex <= acquired.get(`material:${identity}:${hash}`)!)
        )
          continue;
        const nodeId =
          receipt.nodeId ??
          [...nodes.values()].find((node) => nodeNotePath(node.path) === receipt.target)?.nodeId;
        const document = nodeId && documents.get(nodeId);
        if (!document || !nodes.has(nodeId!)) continue;
        const locator = {
          kind: "path" as const,
          anchor: "bundle" as const,
          target: nodeNotePath(document.path),
          suffix,
        };
        try {
          let selections = materialHashesByRaw.get(document.raw);
          if (!selections) materialHashesByRaw.set(document.raw, (selections = new Map()));
          let oldHashes = selections.get(locator.suffix);
          if (!oldHashes) {
            try {
              oldHashes = legacyTextVersions(materialContent(document.raw, locator));
            } catch {
              oldHashes = [];
            }
            selections.set(locator.suffix, oldHashes);
          }
          for (const old of oldHashes)
            if (hashes.has(old) && eventIndex <= acquired.get(`material:${identity}:${old}`)!) {
              (result.materials[identity] ??= {})[old] = materialVersion(
                document.raw,
                locator.target,
                nodes,
                () => nodeMaterialFingerprint(document.raw, locator, nodes),
                locator.suffix,
              );
            }
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
