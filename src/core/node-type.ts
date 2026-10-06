export const NODE_TYPE_PRIMARY_VALUES = ["goal", "prompt", "output"] as const;

/** Suggested labels only; any non-empty secondary suffix remains valid. */
export const NODE_TYPE_PRESETS = [
  "goal-direction",
  "goal-requirement",
  "prompt-decision",
  "prompt-spec",
  "prompt-reference",
  "prompt-procedure",
  "output-asset",
  "output-evidence",
  "output-analysis",
  "output-issue",
] as const;

export type NodeTypePrimary = (typeof NODE_TYPE_PRIMARY_VALUES)[number];

export function isNodeTypePrimary(value: string): value is NodeTypePrimary {
  return (NODE_TYPE_PRIMARY_VALUES as readonly string[]).includes(value);
}

/**
 * Return the primary type marker when the string is canonically shaped.
 * Invalid or absent values return null instead of throwing so callers can
 * decide whether to fail or treat the type as unsupported.
 */
export function nodeTypePrimary(value: string | undefined | null): NodeTypePrimary | null {
  try {
    const type = normalizeOptionalNodeType(value);
    const dash = type.indexOf("-");
    return (dash === -1 ? type : type.slice(0, dash)) as NodeTypePrimary;
  } catch {
    return null;
  }
}

/**
 * Canonical Node type marker.
 *
 * Every user Node must persist one canonical `primary[-secondary]` string fact.
 * `primary` is fixed to goal|prompt|output; `secondary` is project-defined,
 * optional, and split at the first "-". There is still no registry or extra
 * lifecycle authority.
 */
export function normalizeOptionalNodeType(value: unknown, label = "Node type"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const type = value.trim();
  if (!type) {
    throw new Error(`${label} must be non-empty.`);
  }
  const dash = type.indexOf("-");
  const primary = dash === -1 ? type : type.slice(0, dash);
  if (!isNodeTypePrimary(primary)) {
    throw new Error(`${label} primary must be one of ${NODE_TYPE_PRIMARY_VALUES.join("|")}.`);
  }
  if (dash !== -1) {
    const secondary = type.slice(dash + 1);
    if (!secondary || secondary !== secondary.trim()) {
      throw new Error(`${label} secondary suffix must be non-empty when present.`);
    }
  }
  return type;
}
