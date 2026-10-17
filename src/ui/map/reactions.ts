// What a region's cards give when put together: facts Tent already holds about each pair, by the three
// Node types. Nothing here judges whether a conclusion still meets its goal; that is for the Agent.
// Rules: Tent Node "UI-图谱画模块依赖与状态", "画布是投影…三种类型起反应" and "验证反应" (cuca 2026-10-16/17).
import type { Graph } from "../data/store.js";
import { primaryOf } from "../data/store.js";
import type { OutputComparison } from "../data/types.js";

/**
 * Core's output comparisons as this page holds them: read for the outputs now in regions, being read
 * again (the last answer still shown, marked as such), not read yet, or the last read failed.
 */
export type Comparisons = {
  map: ReadonlyMap<string, OutputComparison>;
  status: "ready" | "refreshing" | "waiting" | "failed";
};
export const noComparisons: Comparisons = { map: new Map(), status: "waiting" };

/** One answer to a comparison read: for which outputs (and workspace), which ask it answered, and what came. */
export type Answer = {
  key: string;
  ask: number;
  map: ReadonlyMap<string, OutputComparison>;
  failed: boolean;
};

/**
 * What the page may show for the read it last asked: the answer to that very ask; the previous answer
 * for the same outputs while the new one is on its way, marked as the last one; nothing when the outputs
 * changed or the latest answer was a failure.
 */
export function comparisonsFor(
  held: Answer | null,
  asked: { key: string; ask: number },
): Comparisons {
  if (!held || held.key !== asked.key) return noComparisons;
  if (held.failed) return { map: new Map(), status: "failed" };
  return { map: held.map, status: held.ask === asked.ask ? "ready" : "refreshing" };
}

/** goal + output: is this conclusion the goal's evidence, and has either moved on since it was written. */
export type Verify = {
  kind: "verify";
  goal: string;
  output: string;
  /** How the output stands to the goal: right under it, further down, only naming it as a source, or not at all. */
  under: "child" | "below" | "source" | "none";
  /**
   * The goal against what the output was written from, as Core compares them; null until that read
   * arrives, or when the goal is not above the output.
   */
  goalState: "current" | "changed" | "unknown" | null;
  /** Whether the comparison was read: a failed read claims nothing, not even the last answer. */
  read: Comparisons["status"];
  /** The output's own materials that changed since it was written, as file names. */
  changed: string[];
  writtenAt: string | null;
};
export type Reaction = Verify;

export type Mark = "ok" | "warn" | "none";
export type Says = "none" | "goal" | "materials" | "unknown" | "waiting" | "failed" | "ok";

/** The one line a reaction leads with, worst first: not evidence, goal moved, materials moved, unknown, all well. */
export function headOf(v: Verify): { mark: Mark; says: Says } {
  if (v.under === "none") return { mark: "none", says: "none" };
  if (v.read === "failed") return { mark: "none", says: "failed" };
  if (v.goalState === "changed") return { mark: "warn", says: "goal" };
  if (v.changed.length) return { mark: "warn", says: "materials" };
  if (v.under === "source") return { mark: "none", says: "unknown" };
  if (v.goalState === null) return { mark: "none", says: "waiting" };
  if (v.goalState === "unknown") return { mark: "none", says: "unknown" };
  return { mark: "ok", says: "ok" };
}

/**
 * What several pairs come to. Pairs that moved lead; "all match" only when every pair is known to match;
 * otherwise how many cannot be told, or that they are still being read.
 */
export function summaryOf(list: readonly Verify[]): {
  mark: Mark;
  says: "moved" | "all" | "unclear" | "waiting" | "failed";
  moved: number;
  unclear: number;
} {
  const heads = list.map(headOf);
  const moved = heads.filter((h) => h.mark === "warn").length;
  const open = heads.filter((h) => h.mark === "none");
  const unclear = open.length;
  if (moved) return { mark: "warn", says: "moved", moved, unclear };
  if (!unclear) return { mark: "ok", says: "all", moved, unclear };
  const says = open.every((h) => h.says === "failed")
    ? "failed"
    : open.every((h) => h.says === "waiting")
      ? "waiting"
      : "unclear";
  return { mark: "none", says, moved, unclear };
}

const fileName = (resource: string) => {
  const name = resource.split(/[\\/]/).filter(Boolean).at(-1) ?? resource;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

export function verifyOf(
  graph: Graph,
  compared: Comparisons,
  goal: string,
  output: string,
): Verify {
  const g = graph.nodes.get(goal),
    o = graph.nodes.get(output);
  let under: Verify["under"] = "none";
  for (
    let up = o?.parentId ?? null, depth = 1;
    up;
    up = graph.nodes.get(up)?.parentId ?? null, depth++
  )
    if (up === goal) {
      under = depth === 1 ? "child" : "below";
      break;
    }
  if (
    under === "none" &&
    g?.incoming.some((i) => i.from.kind === "node" && i.from.id === output && i.via === "sources")
  )
    under = "source";
  const c = compared.status === "failed" ? undefined : compared.map.get(output);
  return {
    kind: "verify",
    goal,
    output,
    under,
    goalState: c?.goals.find((x) => x.goalId === goal)?.state ?? null,
    changed: (c?.changedSince ?? []).flatMap((x) =>
      x.kind === "material" ? [fileName(x.resource)] : [],
    ),
    writtenAt: o?.outputAt ?? null,
    read: c || compared.status === "failed" ? compared.status : "waiting",
  };
}

/** The outputs among `members` that react with a goal there, whose comparisons the reactions need. */
export function outputsToCompare(graph: Graph, members: readonly string[]): string[] {
  const typed = (type: string) =>
    members.filter((id) => {
      const n = graph.nodes.get(id);
      return !!n && primaryOf(n.type) === type;
    });
  return typed("goal").length ? typed("output") : [];
}

/** Every reaction among a region's cards: for now each goal with each output. */
export function reactionsIn(
  graph: Graph,
  compared: Comparisons,
  members: readonly string[],
): Reaction[] {
  const typeOf = (id: string) => {
    const n = graph.nodes.get(id);
    return n ? primaryOf(n.type) : null;
  };
  const goals = members.filter((id) => typeOf(id) === "goal");
  const outputs = members.filter((id) => typeOf(id) === "output");
  return goals.flatMap((g) => outputs.map((o) => verifyOf(graph, compared, g, o)));
}

/** The Node types a card of `type` reacts with, so they can light up while it is dragged. */
export const reactsWith = (type: string): string[] => {
  const p = primaryOf(type);
  return p === "goal" ? ["output"] : p === "output" ? ["goal"] : [];
};
