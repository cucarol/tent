import type { CatalogNode } from "./node-catalog.js";
import { parseFrontmatter, type ParsedFrontmatter } from "./frontmatter.js";
import { materialIdentity, materialLocator } from "./material.js";
import { nodeNotePath } from "./paths.js";
import { canonicalIdentityError } from "./tree.js";
import { rewriteMarkdownDestinations } from "../markdown/links.js";

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

const identityValidity = new WeakMap<ParsedFrontmatter, boolean>();
/** Retained bytes pass the same identity and type rules as a live document. */
export function historicalIdentityValid(parsed: ParsedFrontmatter): boolean {
  let valid = identityValidity.get(parsed);
  if (valid === undefined) {
    valid = canonicalIdentityError(parsed.data) === undefined;
    identityValidity.set(parsed, valid);
  }
  return valid;
}

/**
 * The Nodes a live `byId` index would hold for these retained documents. An
 * unparseable or invalid document leaves out its whole subtree, so nothing
 * below it counts as an output, a material Node or a dependency.
 */
export function historicalNodeCatalog(
  documents: Documents,
  readFrontmatter = parseFrontmatter,
): Map<string, CatalogNode> {
  const parsedById = new Map<string, ParsedFrontmatter>();
  const invalidPaths = new Set<string>();
  for (const [nodeId, document] of documents) {
    try {
      const parsed = readFrontmatter(document.raw);
      if (historicalIdentityValid(parsed)) parsedById.set(nodeId, parsed);
      else invalidPaths.add(document.path);
    } catch {
      invalidPaths.add(document.path);
    }
  }
  const isolated = (path: string) => {
    for (let at = path; at; at = at.slice(0, Math.max(0, at.lastIndexOf("/"))))
      if (invalidPaths.has(at)) return true;
    return false;
  };
  const nodes = new Map<string, CatalogNode>();
  for (const [nodeId, document] of documents) {
    const parsed = parsedById.get(nodeId);
    if (!parsed || (invalidPaths.size && isolated(document.path))) continue;
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
