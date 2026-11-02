import { documentLifecycle } from "../base/document-status.js";
import { structureMaterialCoverage } from "../base/material-coverage.js";
import { nodeNotePath } from "../base/paths.js";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import type { ContextNode } from "./card-references.js";
import {
  nodeBodyContent,
  readNodeBodyHistory,
  type RetainedBodyNode,
} from "./node-body-history.js";

export type GoalOpenState = {
  nodeId: string;
} & (
  | { state: "closed"; basis: "structure" | "output" }
  | { state: "open"; basis: "no-output" }
  | { state: "unknown"; basis: "history" }
);

const active = (node: { data: Record<string, unknown> }) => {
  const status = documentLifecycle(node.data).status;
  return status === "stable" || status === "draft";
};
const within = (goal: { path: string }, node: { path: string }) =>
  node.path.startsWith(goal.path + "/");

/** Current valid structure declarations implement their own and ancestor goals. */
function ownsCode(node: ContextNode, workspaceRoot: string) {
  if (node.data.type !== "goal" || !active(node) || !Array.isArray(node.data.sources)) return false;
  return node.data.sources.some(
    (source) =>
      source &&
      source.track === "structure" &&
      typeof source.resource === "string" &&
      !!structureMaterialCoverage(source.resource, nodeNotePath(node.path), workspaceRoot),
  );
}

/** Read-only factual goal state for agent context; no task or confirmation ledger. */
export async function readGoalOpenStates(
  inputFs: FsAdapter,
  workspaceRoot: string,
  nodes: readonly ContextNode[],
  goalIds: readonly string[],
): Promise<GoalOpenState[]> {
  const fs = readOnlyFs(inputFs);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const goals = [...new Set(goalIds)].flatMap((id) => {
    const node = byId.get(id);
    return node && node.data.type === "goal" && active(node) ? [node] : [];
  });
  const code = nodes.filter((node) => ownsCode(node, workspaceRoot));
  const codeGoals = new Set(
    goals
      .filter((goal) => code.some((node) => node.nodeId === goal.nodeId || within(goal, node)))
      .map((goal) => goal.nodeId),
  );
  const pending = goals.filter((goal) => !codeGoals.has(goal.nodeId));
  const result = new Map<string, GoalOpenState>(
    goals
      .filter((goal) => codeGoals.has(goal.nodeId))
      .map((goal) => [goal.nodeId, { nodeId: goal.nodeId, state: "closed", basis: "structure" }]),
  );
  if (!pending.length) return goals.map((goal) => result.get(goal.nodeId)!);
  const history = await readNodeBodyHistory(fs);
  const outputs = nodes.filter((node) => node.data.type === "output" && active(node));
  const candidates = new Map(
    pending.map((goal) => [goal.nodeId, outputs.filter((node) => within(goal, node))]),
  );
  // Replay identity relationships, so moving a whole subtree is not a fresh output placement.
  const retained = new Map<string, RetainedBodyNode | null | undefined>();
  const placements = new Map(
    pending.map((goal) => [goal.nodeId, new Map<string, number | undefined>()]),
  );
  const relationship = (state: typeof retained, goalId: string, outputId: string) => {
    const goal = state.has(goalId) ? state.get(goalId) : null;
    const output = state.has(outputId) ? state.get(outputId) : null;
    if (goal === undefined || output === undefined) return undefined;
    if (output && documentLifecycle(output.data).status === null) return undefined;
    return (
      !!goal && !!output && output.data.type === "output" && active(output) && within(goal, output)
    );
  };
  for (const event of history?.events ?? []) {
    for (const change of event.changes) retained.set(change.nodeId, change.before);
    const after = new Map(retained);
    for (const change of event.changes) after.set(change.nodeId, change.after);
    for (const goal of pending) {
      const placed = placements.get(goal.nodeId)!;
      for (const output of candidates.get(goal.nodeId)!) {
        const before = relationship(retained, goal.nodeId, output.nodeId);
        const next = relationship(after, goal.nodeId, output.nodeId);
        if (next === false) placed.delete(output.nodeId);
        else if (next === undefined || before === undefined) placed.set(output.nodeId, undefined);
        else if (!before) placed.set(output.nodeId, event.order);
      }
    }
    retained.clear();
    for (const [id, node] of after) retained.set(id, node);
  }
  for (const goal of pending) {
    const changed = history?.changed.get(goal.nodeId);
    if (
      !changed ||
      changed.order === null ||
      nodeBodyContent(goal.body, nodeNotePath(goal.path), byId) !== changed.content
    ) {
      result.set(goal.nodeId, { nodeId: goal.nodeId, state: "unknown", basis: "history" });
      continue;
    }
    let uncertain = false;
    let closed = false;
    for (const output of candidates.get(goal.nodeId)!) {
      const saved = history?.latest.get(output.nodeId);
      const placed = placements.get(goal.nodeId)!.get(output.nodeId);
      if (
        !saved ||
        saved.data.type !== "output" ||
        !active(saved) ||
        !relationship(retained, goal.nodeId, output.nodeId) ||
        placed === undefined
      ) {
        uncertain = true;
        continue;
      }
      if (placed >= changed.order) closed = true;
    }
    result.set(
      goal.nodeId,
      closed
        ? { nodeId: goal.nodeId, state: "closed", basis: "output" }
        : uncertain
          ? { nodeId: goal.nodeId, state: "unknown", basis: "history" }
          : { nodeId: goal.nodeId, state: "open", basis: "no-output" },
    );
  }
  return goals.map((goal) => result.get(goal.nodeId)!);
}
