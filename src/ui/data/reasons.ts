/** Behind reasons grouped by what they say, read from the stable prefixes Core writes. */
export type BehindSummary = {
  /** File names of materials that changed. */
  changed: string[];
  /** File names of materials deleted from the main checkout. */
  deleted: string[];
  /** Materials with no retained baseline: a review and one confirmation settle them. */
  baseline: number;
  /** Materials Tent cannot compare, such as remote addresses. */
  uncertain: number;
  /** The date the content expired, when it did. */
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
    else if (/no retained baseline|cannot be reconstructed/.test(reason)) summary.baseline++;
    else if ((match = /^Content is stale on or after (.+)$/.exec(reason)))
      summary.stale = match[1]!;
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

/** Why a goal is ahead: nothing answers it yet, or its outputs have not caught up with it. */
export const aheadKind = (reasons: readonly string[] = []) =>
  reasons.some((r) => r.startsWith("Implementation output is behind"))
    ? ("behind" as const)
    : ("empty" as const);
