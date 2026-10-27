import path from "node:path";
import type { FsAdapter } from "../store/adapter.js";
import type { DocumentVersion } from "../store/history-port.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { buildOkfNodeIndex } from "../base/okf-index.js";
import { extractOutLinksDetailed, resolveOutLink } from "../base/links.js";
import { markdownSyntax } from "../base/markdown-syntax.js";
import { resolveTargetPath } from "../base/link-target.js";
import { isNodeId } from "../base/id.js";
import { canonicalIdentityError } from "../store/tree.js";
import { nodeNotePath, cardRecordPath } from "../base/paths.js";
import { selectSection } from "../base/markdown-section.js";
import { parseCardDocument, verifyCardSourceVersions } from "../graph/card-document.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

/** Mask code examples without moving UTF-16 positions or line endings. */
export function withoutCode(body: string) {
  const ranges: { start: number; end: number }[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "code" || node.type === "inlineCode")
      ranges.push({ start: node.position!.start.offset!, end: node.position!.end.offset! });
    else if ("children" in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(body));
  for (const range of ranges.reverse())
    body =
      body.slice(0, range.start) +
      body.slice(range.start, range.end).replace(/[^\r\n]/g, " ") +
      body.slice(range.end);
  return body;
}

export type ContextNode = {
  nodeId: string;
  name: string;
  path: string;
  raw: string;
  body: string;
  data: Record<string, unknown>;
  version?: DocumentVersion;
};

/** A version is opaque: the history adapter alone supplies the immutable directory. */
export async function historicalContextNodes(fs: FsAdapter, commit: string) {
  if (!fs.history) throw new Error("Retained history unavailable");
  const candidates: ContextNode[] = [];
  for (const [file, raw] of await fs.history.readDirectory(commit)) {
    const directory = path.posix.dirname(file);
    if (file.startsWith("cards/") || file.startsWith("roles/") || nodeNotePath(directory) !== file)
      continue;
    try {
      const { data, body } = parseFrontmatter(raw);
      if (canonicalIdentityError(data)) continue;
      candidates.push({
        nodeId: String(data.id),
        name: path.posix.basename(directory),
        path: directory,
        raw,
        body,
        data,
        version: { commit, path: file },
      });
    } catch {
      /* An invalid historical document cannot establish an identity. */
    }
  }
  const counts = new Map<string, number>();
  for (const node of candidates) counts.set(node.nodeId, (counts.get(node.nodeId) ?? 0) + 1);
  return candidates.filter((node) => counts.get(node.nodeId) === 1);
}

export type BodyNodeReference = {
  raw: string;
  kind: "link" | "mention";
  nodeId?: string;
  targetNodeId?: string;
  version?: DocumentVersion;
  heading?: string;
  reason?: string;
  scope?: "node" | "file";
};

/** Resolve against exactly the supplied identities and heading bytes, never today's path reuse. */
export function resolveBodyNodeReferences(
  body: string,
  owner: string,
  nodes: readonly ContextNode[],
  bindings: ReadonlyMap<string, ContextNode | Error> = new Map(),
) {
  body = withoutCode(body);
  const index = buildOkfNodeIndex(
    nodes.map((node) => ({ ...node, id: node.nodeId, notePath: nodeNotePath(node.path) })),
  );
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const references: BodyNodeReference[] = [];
  for (const link of extractOutLinksDetailed(body, true)) {
    if (link.kind === "artifact") continue;
    const resolved = resolveOutLink(index, link, owner);
    const normalized = resolveTargetPath(link.raw, owner);
    // Normalization can erase explicit path syntax; only an authored ID overrides aliases.
    const canonicalId = link.targetPath;
    const targetNodeId =
      canonicalId && isNodeId(canonicalId) && bindings.has(canonicalId)
        ? canonicalId
        : resolved.targetNodeId;
    const bound = targetNodeId ? bindings.get(targetNodeId) : undefined;
    const node =
      bound instanceof Error
        ? undefined
        : (bound ?? (targetNodeId ? byId.get(targetNodeId) : undefined));
    if (!node) {
      references.push({
        raw: link.raw,
        kind: "link",
        scope:
          normalized.startsWith("../") ||
          normalized.startsWith("roles/") ||
          normalized.startsWith("cards/")
            ? "file"
            : "node",
        reason:
          bound instanceof Error
            ? bound.message
            : "Target did not resolve to a unique Node in the selected source",
        ...(targetNodeId ? { targetNodeId } : {}),
        ...(link.fragment ? { heading: link.fragment } : {}),
      });
      continue;
    }
    try {
      const heading = link.fragment ? decodeURIComponent(link.fragment) : undefined;
      if (heading) selectSection(node.body, heading);
      references.push({
        raw: link.raw,
        kind: "link",
        nodeId: node.nodeId,
        version: node.version,
        ...(heading ? { heading } : {}),
      });
    } catch (error) {
      references.push({
        raw: link.raw,
        kind: "link",
        scope: "node",
        targetNodeId: node.nodeId,
        version: node.version,
        ...(link.fragment ? { heading: link.fragment } : {}),
        reason: String(error),
      });
    }
  }
  // Link destinations are already represented; bare handles use the exact source identity set.
  const exclusions = markdownSyntax(body).mentionExclusions;
  for (const mention of body.matchAll(/(?<![a-zA-Z0-9_./\\-])node-[a-z0-9]+(?![a-zA-Z0-9_-])/g)) {
    const suffix = body.slice(mention.index + mention[0].length);
    // A component, extension or following directory is a file address, not a bare handle.
    // A terminal period remains ordinary prose punctuation.
    if (/^[\\/]/.test(suffix) || /^\.[\p{L}\p{N}_]/u.test(suffix)) continue;
    if (exclusions.some((range) => range.start <= mention.index && mention.index < range.end))
      continue;
    const bound = bindings.get(mention[0]);
    const node = bound instanceof Error ? undefined : (bound ?? byId.get(mention[0]));
    const quoted = /^「([^」\r\n]+)」/.exec(suffix);
    const heading = quoted?.[1];
    let reason = bound instanceof Error ? bound.message : undefined;
    if (suffix.startsWith("「") && !quoted) reason = `Invalid literal heading after ${mention[0]}`;
    if (node && heading)
      try {
        selectSection(node.body, heading);
      } catch (error) {
        reason = String(error);
      }
    references.push(
      node && !reason
        ? {
            raw: mention[0],
            kind: "mention",
            nodeId: node.nodeId,
            version: node.version,
            ...(heading ? { heading } : {}),
          }
        : {
            raw: mention[0],
            kind: "mention",
            scope: "node",
            ...(node
              ? { targetNodeId: node.nodeId, version: node.version }
              : bound instanceof Error
                ? { targetNodeId: mention[0] }
                : {}),
            ...(suffix.startsWith("「") ? { heading: heading ?? "" } : {}),
            reason: reason ?? "Node id unavailable in the selected source",
          },
    );
  }
  return references;
}

/** Card body identity comes from publication; callers may project that verified id onto live paths. */
export async function readCardBodyReferences(fs: FsAdapter, cardId: string) {
  const file = cardRecordPath(cardId);
  if (!fs.history) throw new Error("Card publication history unavailable");
  const publication = (await fs.history.pathVersions(file)).first;
  if (!publication) throw new Error("Card has no retained publication");
  const card = parseCardDocument(cardId, await fs.history.read(publication));
  const nodes = await historicalContextNodes(fs, publication.commit);
  const bindings = new Map<string, ContextNode | Error>();
  const sources = card.data.sources.filter((source) => source.version !== undefined);
  const pins = await verifyCardSourceVersions(
    fs,
    sources.map((source) => ({ owner: file, source })),
  );
  for (const [index, read] of pins.entries()) {
    if (read instanceof Error) {
      const address = sources[index]!.resource.split("#")[0]!;
      for (const ref of resolveBodyNodeReferences(`[source](${address})`, file, nodes))
        if (ref.nodeId) bindings.set(ref.nodeId, read);
      continue;
    }
    const selected = (await historicalContextNodes(fs, read.version.commit)).find(
      (node) => node.version?.path === read.version.path,
    );
    if (!selected) {
      bindings.set(
        String(parseFrontmatter(read.raw).data.id),
        new Error("Pinned source is not a unique historical Node"),
      );
      continue;
    }
    const previous = bindings.get(selected.nodeId);
    bindings.set(
      selected.nodeId,
      previous &&
        (previous instanceof Error ||
          previous.version?.commit !== selected.version?.commit ||
          previous.version?.path !== selected.version?.path)
        ? new Error(`Ambiguous pinned versions for ${selected.nodeId}`)
        : selected,
    );
  }
  return {
    publication,
    card,
    nodes,
    references: resolveBodyNodeReferences(card.body, file, nodes, bindings),
  };
}
