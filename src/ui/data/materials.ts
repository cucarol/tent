import type { MaterialState } from "./types.js";

/**
 * What the Node page says about one of a Node's materials, as plain fact: changed since the Node was
 * written, deleted, or not readable now. Nothing for a material that is as it was, or that Tent has no
 * record to compare with: a missing record is Tent's own bookkeeping, not something about the file.
 */
export type MaterialFact = "changed" | "deleted" | "unreadable";

export function materialFact(m: MaterialState): MaterialFact | null {
  if (m.state === "changed") return "changed";
  if (m.state !== "unavailable") return null;
  const reason = m.reason ?? "";
  if (/no retained baseline|cannot be reconstructed/.test(reason)) return null;
  // Core writes a missing file's read error, or that the main checkout deleted it.
  return /^ENOENT:|deleted in the main checkout/.test(reason) ? "deleted" : "unreadable";
}

/** Each material's fact by its address, for the materials the Node page lists. */
export function materialFacts(list: readonly MaterialState[]): Map<string, MaterialFact> {
  const out = new Map<string, MaterialFact>();
  for (const m of list) {
    const fact = materialFact(m);
    if (fact) out.set(m.resource, fact);
  }
  return out;
}
