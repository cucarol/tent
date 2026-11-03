/** The three persisted Node type names; they do not select runtime behavior. */
export const NODE_TYPES = ["goal", "prompt", "output"] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

/** Every current Node persists exactly one of the three types. */
export function normalizeOptionalNodeType(value: unknown, label = "Node type"): NodeType {
  if (!isNodeType(value)) throw new Error(`${label} must be goal, prompt or output.`);
  return value;
}
