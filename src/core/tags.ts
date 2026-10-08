import type { Node } from "./types.js";

/**
 * Suggested tag words for a Node's form or topic. Tags carry no behavior and
 * have no registry; any valid tag is allowed, but reuse beats new synonyms.
 */
export const NODE_TAG_PRESETS = [
  "direction",
  "requirement",
  "decision",
  "spec",
  "reference",
  "procedure",
  "asset",
  "evidence",
  "analysis",
  "issue",
] as const;

export function isNodeTagPreset(tag: string): boolean {
  return (NODE_TAG_PRESETS as readonly string[]).includes(tag);
}

export type NodeTagCount = { tag: string; count: number; preset: boolean };

/** Tags in use, most used first; deprecated Nodes count only when included. */
export function countNodeTags(
  nodes: Iterable<Pick<Node, "tags" | "archived">>,
  options: { includeArchived?: boolean } = {},
): NodeTagCount[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.archived && !options.includeArchived) continue;
    for (const tag of new Set(node.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count, preset: isNodeTagPreset(tag) }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Tags are derived from documents; there is no separate vocabulary to update. */
export function collectNodeTags(tent: { byId: Map<string, Node> }): string[] {
  return [...new Set([...tent.byId.values()].flatMap((node) => node.tags))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function findNodesByTag(tent: { byId: Map<string, Node> }, name: string): Node[] {
  const tag = normalizeTagName(name);
  return [...tent.byId.values()]
    .filter((node) => node.tags.includes(tag))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** A document's tags as every reader sees them: trimmed, non-empty, first occurrence kept. */
export function normalizeNodeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function normalizeTagName(name: string): string {
  const tag = name.trim();
  if (!tag) throw new Error("Tag name cannot be empty.");
  if (/[\/\\\r\n]/.test(tag))
    throw new Error("Tag name cannot contain path separators or newlines.");
  return tag;
}

export function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Tags must be a string array.");
  }
  return [...new Set(value.map(normalizeTagName))].sort((a, b) => a.localeCompare(b));
}
