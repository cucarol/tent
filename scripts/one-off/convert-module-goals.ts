// Run with node --import tsx. Review the dry-run report before stopping all writers and applying.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFs } from "../../src/fs/node-fs.js";
import { loadNodeCatalog, readCatalogDocument } from "../../src/core/graph/node-catalog.js";
import { parseFrontmatter } from "../../src/core/base/frontmatter.js";
import { rewriteMarkdownDestinations } from "../../src/core/base/links.js";
import { isCoverageGoal } from "../../src/core/base/material-coverage.js";
import { coverageGoalAncestors } from "../../src/core/graph/node-sync-record.js";
import { normalizeTagList } from "../../src/core/base/tags.js";
import { nodeNotePath } from "../../src/core/base/paths.js";
import {
  writeNodesBatch,
  type NodeWriteBatchInput,
} from "../../src/core/write/node-write-batch.js";

export type ModuleGoalConversion = {
  nodeId: string;
  baseEtag: string;
  goalBody: string;
  rulesName: string;
  rulesTags: string[];
  rulesBody: string;
};

export const childRulesBody = (body: string) =>
  rewriteMarkdownDestinations(body, (url) => (/^(?:\.\.?\/)/.test(url) ? "../" + url : undefined));

export async function convertModuleGoals(
  workspace: string,
  entries: ModuleGoalConversion[],
  apply = false,
) {
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  try {
    const catalog = await loadNodeCatalog(adapter);
    const prospectiveNodes = new Map(catalog.byId);
    for (const entry of entries) {
      const node = prospectiveNodes.get(entry.nodeId);
      if (node) prospectiveNodes.set(entry.nodeId, { ...node, type: "goal" });
    }
    const groupingGoals = coverageGoalAncestors(prospectiveNodes, workspace);
    const items: NodeWriteBatchInput["items"] = [];
    const report = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.nodeId)) throw new Error(`Duplicate entry: ${entry.nodeId}`);
      seen.add(entry.nodeId);
      const rulesTags = normalizeTagList(entry.rulesTags);
      const node = catalog.byId.get(entry.nodeId);
      if (!node || node.invalid || node.archived)
        throw new Error(`Unavailable Node: ${entry.nodeId}`);
      const document = await readCatalogDocument(adapter, node);
      const parsed = parseFrontmatter(document.raw);
      const childPath = `${node.path}/${entry.rulesName}`;
      const child = [...catalog.byId.values()].find((candidate) => candidate.path === childPath);
      if (node.type === "goal" && parsed.body === entry.goalBody && child?.type === "prompt") {
        const childDocument = parseFrontmatter((await readCatalogDocument(adapter, child)).raw);
        if (
          childDocument.body !== entry.rulesBody ||
          JSON.stringify(childDocument.data.tags) !== JSON.stringify(rulesTags)
        )
          throw new Error(`Converted rules changed: ${entry.nodeId}`);
        report.push({ nodeId: node.nodeId, path: node.path, state: "already-converted" });
        continue;
      }
      if (document.etag !== entry.baseEtag) throw new Error(`Stale manifest: ${entry.nodeId}`);
      if (node.type !== "prompt" || child)
        throw new Error(`Unexpected conversion state: ${entry.nodeId}`);
      if (
        !isCoverageGoal({ ...parsed.data, type: "goal" }, nodeNotePath(node.path), workspace) &&
        !groupingGoals.has(node.nodeId)
      )
        throw new Error(`Not a local directory or prefix goal: ${entry.nodeId}`);
      if (!entry.rulesTags.includes("spec") || entry.rulesBody !== childRulesBody(parsed.body))
        throw new Error(`Rules must preserve the original body and include spec: ${entry.nodeId}`);
      items.push({
        op: "update",
        nodeId: node.nodeId,
        baseEtag: document.etag,
        frontmatter: { type: "goal" },
        body: entry.goalBody,
        confirm: true,
      });
      items.push({
        op: "create",
        ref: `rules${items.length}`,
        parent: node.nodeId,
        name: entry.rulesName,
        type: "prompt",
        tags: rulesTags,
        body: entry.rulesBody,
      });
      report.push({
        nodeId: node.nodeId,
        path: node.path,
        state: "planned",
        before: document.raw,
        after: {
          type: "goal",
          body: entry.goalBody,
          materials: { resource: parsed.data.resource, sources: parsed.data.sources },
          preservedChildren: node.childNodeIds,
          rules: { path: childPath, tags: rulesTags, body: entry.rulesBody },
        },
      });
    }
    const result =
      apply && items.length
        ? await writeNodesBatch(
            {
              fs: adapter,
              clock: { now: () => new Date().toISOString() },
              tentName: path.basename(workspace),
            },
            { items },
          )
        : undefined;
    return { applied: !!result, report, result };
  } finally {
    await adapter.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [workspace, manifest, ...flags] = process.argv.slice(2);
  if (!workspace || !manifest || flags.some((flag) => flag !== "--apply"))
    throw new Error(
      "Usage: node --import tsx scripts/one-off/convert-module-goals.ts <workspace> <manifest.json> [--apply]",
    );
  const entries = JSON.parse(await fs.readFile(manifest, "utf8")) as ModuleGoalConversion[];
  console.log(
    JSON.stringify(
      await convertModuleGoals(path.resolve(workspace), entries, flags.includes("--apply")),
      null,
      2,
    ),
  );
}
