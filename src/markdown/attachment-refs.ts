import * as nodePath from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";
import { ATTACHMENTS_DIR, TENT_SYSTEM_DIR } from "../core/paths.js";

export type AttachmentReference = {
  path: string;
  kind: "image" | "link";
  raw: string;
};

/**
 * Resolve an attachment pointer to a path relative to the Tent system root.
 * Used by graph export without adding attachment edges to Node backlinks.
 */
function resolveAttachmentPath(raw: string, sourcePath?: string): string | undefined {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (!target || target.startsWith("#") || target.startsWith("//")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;

  try {
    target = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  target = (target.split("#")[0]?.split("?")[0] ?? target).replace(/\\/g, "/").trim();
  if (!target) return undefined;

  const ownedPath = (value: string) => value.startsWith(`${ATTACHMENTS_DIR}/`);
  if (
    target.startsWith(`${TENT_SYSTEM_DIR}/`) &&
    ownedPath(target.slice(TENT_SYSTEM_DIR.length + 1))
  )
    target = target.slice(TENT_SYSTEM_DIR.length + 1);
  if (target.startsWith("/") && ownedPath(target.slice(1))) target = target.slice(1);

  let normalized: string;
  if (target === ATTACHMENTS_DIR || ownedPath(target)) {
    normalized = nodePath.posix.normalize(target);
  } else if ((target.startsWith("./") || target.startsWith("../")) && sourcePath) {
    normalized = nodePath.posix.normalize(
      nodePath.posix.join(nodePath.posix.dirname(sourcePath.replace(/\\/g, "/")), target),
    );
  } else {
    return undefined;
  }

  if (!ownedPath(normalized) || normalized.includes("\0")) return undefined;
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) return undefined;
  return normalized;
}

/** Extract semantic attachment references from Markdown prose. */
export function extractAttachmentReferences(
  markdown: string,
  sourcePath?: string,
): AttachmentReference[] {
  const tree: Root = fromMarkdown(markdown);
  const definitions = collectDefinitions(tree);
  const out: AttachmentReference[] = [];
  const seen = new Set<string>();

  walk(tree, (node) => {
    if (node.type === "image" || node.type === "link") {
      push(out, seen, node.url, node.type === "image" ? "image" : "link", sourcePath);
      return "skip";
    }
    if (node.type === "imageReference" || node.type === "linkReference") {
      const definition = definitions.get(normalizeIdentifier(node.identifier));
      if (definition) {
        push(
          out,
          seen,
          definition.url,
          node.type === "imageReference" ? "image" : "link",
          sourcePath,
        );
      }
      return "skip";
    }
  });
  return out;
}

function collectDefinitions(tree: Root): Map<string, { url: string }> {
  const definitions = new Map<string, { url: string }>();
  walk(tree, (node) => {
    if (node.type === "definition") {
      definitions.set(normalizeIdentifier(node.identifier), { url: node.url });
    }
  });
  return definitions;
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function walk(node: Nodes, visit: (node: Nodes) => "skip" | void): void {
  if (visit(node) === "skip") return;
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) walk(child as Nodes, visit);
  }
}

function push(
  out: AttachmentReference[],
  seen: Set<string>,
  raw: string,
  kind: AttachmentReference["kind"],
  sourcePath?: string,
): void {
  const path = resolveAttachmentPath(raw, sourcePath);
  if (!path) return;
  const key = `${kind}:${path}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ path, kind, raw });
}
