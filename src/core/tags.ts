import type { Node } from "./types.js";

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
