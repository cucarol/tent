/**
 * The map says a Node has expired but not when; this stands for it until materials are compared, when
 * Core's own reason with the date replaces it.
 */
export const MAP_STALE = "Content is stale";

/** Behind reasons grouped by what they say, read from the stable prefixes Core writes. */
export type BehindSummary = {
  /** File names of materials that changed. */
  changed: string[];
  /** File names of materials deleted, from the main checkout or from the workspace. */
  deleted: string[];
  /** Materials with no retained baseline: a review and one confirmation settle them. */
  baseline: number;
  /** Materials Tent cannot compare, such as remote addresses. */
  uncertain: number;
  /** The date the content expired, when it did; empty when only the expiry is known. */
  stale: string | null;
  /** Reasons of no known kind, shown as written. */
  other: string[];
};

/** Reasons carry encoded addresses such as "SPEC.md#Reception%20and%20outputs". */
function decode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
const fileName = (address: string) => decode(address.split(/[\\/]/).pop() ?? address);

export function summarizeBehind(reasons: readonly string[]): BehindSummary {
  const summary: BehindSummary = {
    changed: [],
    deleted: [],
    baseline: 0,
    uncertain: 0,
    stale: null,
    other: [],
  };
  for (const raw of reasons) {
    // Reasons inherited from a goal on the chain name it first.
    const reason = raw.replace(/^Goal \S+: /, "");
    let match: RegExpExecArray | null;
    if ((match = /^Material changed: (.+)$/.exec(reason)))
      summary.changed.push(fileName(match[1]!));
    else if (
      (match = /^Repository material was deleted in the main checkout: .*: (.+)$/.exec(reason))
    )
      summary.deleted.push(fileName(match[1]!));
    // A material that could not be read because it is gone: Core writes the error, then the address.
    else if (reason.startsWith("ENOENT:") && reason.lastIndexOf(": ") > 6)
      summary.deleted.push(fileName(reason.slice(reason.lastIndexOf(": ") + 2)));
    else if (/no retained baseline|cannot be reconstructed/.test(reason)) summary.baseline++;
    else if ((match = /^Content is stale(?: on or after (.+))?$/.exec(reason)))
      summary.stale = match[1] ?? "";
    else if (
      /^(Remote material version is unknown|Material observer is unavailable|Source is not an explicit local address)/.test(
        reason,
      )
    )
      summary.uncertain++;
    else summary.other.push(reason);
  }
  summary.changed = [...new Set(summary.changed)];
  summary.deleted = [...new Set(summary.deleted)];
  return summary;
}

/**
 * Why a goal is ahead: nothing answers it yet; it has outputs but none was saved or confirmed against its
 * current content and materials; or, for a goal that covers directories or prefixes and so is carried out
 * by them, neither the goal itself as it is now nor a current output was confirmed. The last two say
 * nothing about what changed: a missing baseline reads the same as a known change.
 */
export type AheadKind = "empty" | "unmatched" | "intent";
export const aheadKind = (reasons: readonly string[] = []): AheadKind =>
  reasons.some((r) => r.startsWith("Neither confirmed goal intent nor a current output matches"))
    ? "intent"
    : reasons.some((r) => r.startsWith("No output under this goal was saved or confirmed"))
      ? "unmatched"
      : "empty";

/**
 * Behind only because a baseline is missing or a material cannot be compared: nothing is known to have
 * changed, and one review and confirmation settles it. Shown quieter than a known change.
 */
export function onlyGaps(reasons: readonly string[]) {
  if (!reasons.length) return false;
  const s = summarizeBehind(reasons);
  return !s.changed.length && !s.deleted.length && s.stale === null && !s.other.length;
}
