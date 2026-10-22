import type { FsAdapter } from "../store/adapter.js";
import {
  isDirectoryMaterial,
  isPrefixMaterial,
  localMaterialPath,
  materialIdentity,
  type MaterialLocator,
  resolvedMaterialOccurrences,
} from "../base/material.js";
import { systemMaterialPath } from "./material-target.js";
import { markdownMaterialHeading } from "../base/material-section.js";
import { markdownSyntax } from "../base/markdown-syntax.js";
import { parseFrontmatter } from "../base/frontmatter.js";

function wholeMarkdownIdentity(locator: MaterialLocator, workspaceRoot?: string) {
  const filename =
    locator.kind === "path"
      ? locator.target
      : locator.kind === "uri" && locator.uri.startsWith("file:")
        ? decodeURIComponent(new URL(locator.uri).pathname)
        : undefined;
  if (
    !filename ||
    !/\.(md|markdown)$/i.test(filename) ||
    markdownMaterialHeading(locator) !== undefined ||
    isDirectoryMaterial(locator) ||
    isPrefixMaterial(locator)
  )
    return;
  const identity = workspaceRoot
    ? localMaterialPath(locator, workspaceRoot)
    : materialIdentity(locator);
  return process.platform === "win32" ? identity?.toLowerCase() : identity;
}

function hasSeveralSections(raw: string) {
  const headings = markdownSyntax(parseFrontmatter(raw).body).headings;
  // A single document title does not count as one of its sections.
  const title = headings[0];
  const sections = title?.depth === 1 ? headings.slice(1) : headings;
  const depth = Math.min(...sections.map((heading) => heading.depth));
  return sections.filter((heading) => heading.depth === depth).length >= 2;
}

/** Advice for explicit writes only; no warning changes a Node's type or synchronization basis. */
export async function nodeMaterialWarnings(
  fs: Pick<FsAdapter, "workspaceRoot" | "materialIsTracked" | "readMaterialText">,
  data: Record<string, unknown>,
  documentPath: string,
  previous: Record<string, unknown> = {},
): Promise<string[]> {
  if (data.type !== "goal" && data.type !== "prompt") return [];
  const retained = new Set(
    resolvedMaterialOccurrences(previous, documentPath).flatMap(({ locator }) => {
      try {
        const identity = locator && wholeMarkdownIdentity(locator, fs.workspaceRoot);
        return identity ? [identity] : [];
      } catch {
        return [];
      }
    }),
  );
  const whole: string[] = [];
  const seen = new Set<string>();
  for (const { resource, locator, track } of resolvedMaterialOccurrences(data, documentPath)) {
    if (!locator || track || !fs.readMaterialText) continue;
    try {
      const identity = wholeMarkdownIdentity(locator, fs.workspaceRoot);
      if (!identity || retained.has(identity) || seen.has(identity)) continue;
      seen.add(identity);
      const text = await fs.readMaterialText(resource, documentPath);
      if (text !== undefined && hasSeveralSections(text)) whole.push(resource);
    } catch {
      /* Advice cannot fail a write when a material cannot be read. */
    }
  }
  const untracked: string[] = [];
  for (const { resource, locator } of resolvedMaterialOccurrences(data, documentPath)) {
    if (
      !locator ||
      locator.kind === "unresolved" ||
      (locator.kind === "uri" && !locator.uri.startsWith("file:")) ||
      isDirectoryMaterial(locator) ||
      isPrefixMaterial(locator) ||
      systemMaterialPath(locator, fs.workspaceRoot) !== undefined ||
      untracked.includes(resource)
    )
      continue;
    // A hint must never turn a successful write into a failed receipt or guess from a Git error.
    if ((await fs.materialIsTracked?.(resource, documentPath).catch(() => undefined)) === false)
      untracked.push(resource);
  }
  const warnings = untracked.length
    ? [
        `${String(data.id ?? "Node")}: Local material is not tracked by Git; Tent cannot inspect how it changed. Record a result from one point in time as output. Materials: ${untracked.map((resource) => JSON.stringify(resource)).join(", ")}`,
      ]
    : [];
  if (whole.length)
    warnings.push(
      `${String(data.id ?? "Node")}: Material is a whole document with several sections; an edit to any of them marks this Node behind. If the Node depends on particular sections, cite those instead (path#Heading). Materials: ${whole.map((resource) => JSON.stringify(resource)).join(", ")}`,
    );
  return warnings;
}
