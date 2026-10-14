import path from "node:path";
import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { nodeSummary, readerResult } from "./context-reader.js";
import { parseFrontmatter } from "./frontmatter.js";
import { documentLifecycle } from "./document-status.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { nodeNotePath } from "./paths.js";
import { normalizeNodeTags } from "./tags.js";
import {
  resourceSchema,
  localMaterialPath,
  materialIdentity,
  materialLocator,
  resolvedMaterialOccurrences,
} from "./material.js";
import {
  isTentWorkspacePath,
  materialCoverageContains,
  structureMaterialCoverage,
} from "./material-coverage.js";

export const nodeResourceSearchSchema = z.strictObject({ resource: resourceSchema });

/** File discovery reads headers only; its revision is never a document edit token. */
export async function searchNodeResources(
  fs: FsAdapter,
  workspaceId: string,
  workspaceRoot: string,
  input: unknown,
  options: { uncaptured?: boolean } = {},
) {
  const request = nodeResourceSearchSchema.parse(input);
  const locator = materialLocator(request.resource, ".search.md", true);
  const identity = materialIdentity(locator);
  if (identity === undefined) throw new Error("Material search requires an explicit path or URI");
  const filename = localMaterialPath(locator, workspaceRoot);
  const workspacePath = filename
    ? path.relative(workspaceRoot, filename).split(path.sep).join("/")
    : undefined;
  const excluded = workspacePath !== undefined && isTentWorkspacePath(workspacePath);
  const catalog = await loadNodeCatalog(fs);
  const retained = options.uncaptured
    ? new Set((await fs.retainedDocumentPaths?.()) ?? [])
    : undefined;
  const hits = [];
  if (!excluded)
    for (const node of catalog.byId.values()) {
      const data = parseFrontmatter(node.header).data;
      const status = documentLifecycle(data).status;
      if (node.archived || (status !== "draft" && status !== "stable")) continue;
      let occurrences;
      try {
        occurrences = resolvedMaterialOccurrences(data, nodeNotePath(node.path));
      } catch {
        // Malformed material metadata cannot establish a file association.
        continue;
      }
      const matches = occurrences.flatMap((occurrence) => {
        if (!occurrence.locator) return [];
        const exact = materialIdentity(occurrence.locator) === identity;
        const coverage = structureMaterialCoverage(
          occurrence.resource,
          nodeNotePath(node.path),
          workspaceRoot,
        );
        if (
          !exact &&
          !(workspacePath && coverage && materialCoverageContains(coverage, workspacePath))
        )
          return [];
        return [
          {
            specificity: exact ? Infinity : coverage!.prefix.length,
            match: {
              kind: exact ? ("exact" as const) : ("coverage" as const),
              field: occurrence.field,
              ...(occurrence.index === undefined ? {} : { index: occurrence.index }),
              resource: occurrence.resource,
            },
          },
        ];
      });
      // One result per Node, with its most specific evidence; broader Nodes still appear.
      matches.sort((a, b) => b.specificity - a.specificity);
      const best = matches[0];
      if (!best) continue;
      hits.push({
        specificity: best.specificity,
        item: {
          ...nodeSummary({ ...node, tags: normalizeNodeTags(data.tags) }),
          match: best.match,
          ...(retained && !retained.has(nodeNotePath(node.path))
            ? { uncaptured: true as const }
            : {}),
        },
      });
    }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  hits.sort(
    (a, b) =>
      b.specificity - a.specificity ||
      compare(a.item.path, b.item.path) ||
      compare(a.item.nodeId, b.item.nodeId),
  );
  const items = hits.map(({ item }) => item);
  return {
    workspaceId,
    ...readerResult({ kind: "live", workspaceId }, canonicalSha256(items), request, items),
  };
}
