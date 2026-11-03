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
