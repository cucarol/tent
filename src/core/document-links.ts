import path from "node:path";
import type { FsAdapter } from "./adapter.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { nodeNotePath } from "./paths.js";
import { extractOutLinksDetailed, rewriteMarkdownDestinations } from "../markdown/links.js";
import { materialOccurrences, type MaterialSource } from "./material.js";

export async function workspaceDocumentPaths(fs: FsAdapter): Promise<Map<string, string>> {
  return new Map(
    [...(await loadNodeCatalog(fs)).byId.values()].map((node) => [
      node.nodeId,
      nodeNotePath(node.path),
    ]),
  );
}

function relativeAddress(fromPath: string, toPath: string): string {
  const relative = path.posix.relative(path.posix.dirname(fromPath), toPath);
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  return encoded.startsWith("../") ? encoded : "./" + encoded;
}

function resolveId(
  url: string,
  paths: ReadonlyMap<string, string>,
  fromPath: string,
): string | undefined {
  const match = /^([^#?]+)(.*)$/.exec(url);
  if (!match) return;
  const target = paths.get(match[1]!);
  return target === undefined ? undefined : relativeAddress(fromPath, target) + match[2];
}

/** Only Markdown destinations that exactly name a known Node id are canonicalized. */
export function canonicalDocumentLinks(
  body: string,
  paths: ReadonlyMap<string, string>,
  fromPath: string,
): string {
  return rewriteMarkdownDestinations(body, (url) => resolveId(url, paths, fromPath));
}

/** Normalize declared Node id inputs without touching labels, unknown metadata or prose. */
export async function canonicalDocumentReferences(
  fs: FsAdapter,
  fromPath: string,
  data: Record<string, unknown>,
  body: string,
): Promise<string> {
  const occurrences = materialOccurrences(data);
  if (
    !occurrences.some((item) => item.resource.startsWith("node-")) &&
    !extractOutLinksDetailed(body).some((link) => link.raw.startsWith("node-"))
  )
    return body;
  const paths = await workspaceDocumentPaths(fs);
  return canonicalDocumentReferencesWithPaths(fromPath, data, body, paths);
}

/** Resolve against a prepared catalog, including Nodes not yet written by a batch. */
export function canonicalDocumentReferencesWithPaths(
  fromPath: string,
  data: Record<string, unknown>,
  body: string,
  paths: ReadonlyMap<string, string>,
): string {
  const occurrences = materialOccurrences(data);
  for (const occurrence of occurrences) {
    const resource = resolveId(occurrence.resource, paths, fromPath);
    if (resource === undefined) continue;
    if (occurrence.field === "resource") data.resource = resource;
    else {
      const sources = [...(data.sources as MaterialSource[])];
      sources[occurrence.index!] = { ...sources[occurrence.index!], resource };
      data.sources = sources;
    }
  }
  return canonicalDocumentLinks(body, paths, fromPath);
}
