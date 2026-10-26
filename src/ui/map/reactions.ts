// What selected topics give when put together: facts Tent already holds about each pair, by the three
// Node types, and whether a goal, a rule and a conclusion close a loop. Nothing here judges whether a
// conclusion meets its goal or two rules contradict; that is for the Agent.
// Rules: Tent Node "UI-图谱画模块依赖与状态", "画布是投影…三种类型起反应", "验证反应" (cuca 2026-10-16/17).
import type { Graph } from "../data/store.js";
import { primaryOf } from "../data/store.js";
import type { OutputComparison } from "../data/types.js";

/**
 * Core's output comparisons as this page holds them: read for the outputs now selected, being read
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
  key = asked.key,
): Comparisons {
  // `key` is the outputs this render shows; the ask for new ones is only made after the render.
  if (!key || asked.key !== key || !held || held.key !== key) return noComparisons;
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

/** goal + prompt: does the rule hang on or link to the goal, and what both name. */
export type Constrain = {
  kind: "constrain";
  goal: string;
  prompt: string;
  on: "child" | "below" | "link" | "none";
  /** Materials both name, by exact path. */
  shared: string[];
};

/**
 * When Core says each card last changed: a body or material address, not a confirmation or other
 * metadata; and for an output, when it was last recorded or confirmed. Null when history cannot show it.
 */
export type NodeTime = { contentChangedAt: string | null; recordedAt: string | null };
export type Times = ReadonlyMap<string, NodeTime>;
export const noTimes: Times = new Map();

/** One answer to a times read: for which Nodes at which revision, which ask it answered, and what came. */
export type TimesAnswer = { key: string; ask: number; map: Times; failed: boolean };

/**
 * The times the page may judge by: only the answer to the very read it asked last, for the Nodes and
 * revision it shows now (`key`, empty when it reads none). While that read is on its way, after it failed,
 * and in the render where the Nodes or the revision just changed, before the new read is even asked,
 * nothing is judged by time, so an order from an earlier revision is never shown as current.
 */
export function timesFor(
  held: TimesAnswer | null,
  asked: { key: string; ask: number },
  key: string,
): Times {
  if (!key || asked.key !== key) return noTimes;
  if (!held || held.failed || held.key !== key || held.ask !== asked.ask) return noTimes;
  return held.map;
}

/**
 * prompt + output: does the conclusion cite the rule, and was the rule last changed before the conclusion
 * was last recorded or after it. The order is null when history cannot tell, absent while not read yet.
 */
export type Contrast = {
  kind: "contrast";
  prompt: string;
  output: string;
  cites: boolean;
  order?: "before" | "after" | "same" | null;
};

/** goal + goal: one above the other, materials they share, rules hanging on both. */
export type Overlap = {
  kind: "overlap";
  a: string;
  b: string;
  family: "a" | "b" | null;
  shared: string[];
  /** Prompts that hang on or link to both goals. */
  rules: string[];
};

/** prompt + prompt: files or directories both rules name. Whether they contradict is for the Agent. */
export type Govern = { kind: "govern"; a: string; b: string; shared: string[] };

/** output + output: the goal each answers, which was written first, and how their materials differ. */
export type Sequence = {
  kind: "sequence";
  a: string;
  b: string;
  goals: [string | null, string | null];
  first: "a" | "b" | "same" | null;
  onlyA: string[];
  onlyB: string[];
  both: number;
};

/** goal + prompt + output: the three links of a closed loop, each there or missing. */
export type Loop = {
  kind: "loop";
  goal: string;
  prompt: string;
  output: string;
  ruleOn: boolean;
  evidence: boolean;
  cites: boolean;
};

export type Reaction = Verify | Constrain | Contrast | Overlap | Govern | Sequence | Loop;
export type Kind = Reaction["kind"];

/** ok: holds; warn: moved or missing; none: cannot be told, or not related at all; info: a plain fact. */
export type Mark = "ok" | "warn" | "none" | "info";
export type Head = { mark: Mark; says: string };

/** The one line a reaction leads with; for each kind the worst fact first. */
export function headOf(r: Reaction): Head {
  switch (r.kind) {
    case "verify":
      if (r.under === "none") return { mark: "none", says: "none" };
      if (r.read === "failed") return { mark: "none", says: "failed" };
      if (r.goalState === "changed") return { mark: "warn", says: "goal" };
      if (r.changed.length) return { mark: "warn", says: "materials" };
      if (r.under === "source") return { mark: "none", says: "unknown" };
      if (r.goalState === null) return { mark: "none", says: "waiting" };
      if (r.goalState === "unknown") return { mark: "none", says: "unknown" };
      return { mark: "ok", says: "ok" };
    case "constrain":
      return r.on === "none" ? { mark: "info", says: "off" } : { mark: "ok", says: "on" };
    case "contrast":
      if (r.order === "after") return { mark: "warn", says: "after" };
      return r.cites ? { mark: "ok", says: "cites" } : { mark: "info", says: "silent" };
    case "overlap":
      if (r.family) return { mark: "info", says: "family" };
      return r.shared.length || r.rules.length
        ? { mark: "info", says: "shares" }
        : { mark: "info", says: "nothing" };
    case "govern":
      return r.shared.length ? { mark: "info", says: "shares" } : { mark: "info", says: "nothing" };
    case "sequence":
      return r.goals[0] && r.goals[0] === r.goals[1]
        ? { mark: "info", says: "same" }
        : { mark: "info", says: "apart" };
    case "loop": {
      const missing = [r.ruleOn, r.evidence, r.cites].filter((x) => !x).length;
      return missing ? { mark: "warn", says: "missing" } : { mark: "ok", says: "whole" };
    }
  }
}

/** Whether a pair has something to say beyond "not related"; only those light up and are listed. */
export function matters(r: Reaction): boolean {
  switch (r.kind) {
    case "verify":
      return r.under !== "none";
    case "constrain":
      return r.on !== "none" || r.shared.length > 0;
    case "contrast":
      return r.cites || r.order === "after";
    case "overlap":
      return !!r.family || r.shared.length > 0 || r.rules.length > 0;
    case "govern":
      return r.shared.length > 0;
    case "sequence":
      return (!!r.goals[0] && r.goals[0] === r.goals[1]) || r.both > 0;
    case "loop":
      return true;
  }
}

/**
 * What several reactions come to. Those that moved or miss a link lead; "all match" only when every one
 * is known to hold; otherwise how many cannot be told, or that they are still being read; and when all
 * that is left are plain facts, that nothing moved.
 */
export function summaryOf(list: readonly Reaction[]): {
  mark: Mark;
  says: "moved" | "all" | "unclear" | "waiting" | "failed" | "facts";
  moved: number;
  unclear: number;
} {
  const heads = list.map(headOf);
  const moved = heads.filter((h) => h.mark === "warn").length;
  const open = heads.filter((h) => h.mark === "none");
  const unclear = open.length;
  if (moved) return { mark: "warn", says: "moved", moved, unclear };
  if (unclear) {
    const says = open.every((h) => h.says === "failed")
      ? "failed"
      : open.every((h) => h.says === "waiting")
        ? "waiting"
        : "unclear";
    return { mark: "none", says, moved, unclear };
  }
  if (heads.every((h) => h.mark === "ok")) return { mark: "ok", says: "all", moved, unclear };
  return { mark: "info", says: "facts", moved, unclear };
}

const fileName = (resource: string) => {
  const name = resource.split(/[\\/]/).filter(Boolean).at(-1) ?? resource;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

/** Where `id` stands under `top`: right under it, further down, or not at all. */
function below(graph: Graph, id: string, top: string): "child" | "below" | null {
  let depth = 1;
  for (
    let up = graph.nodes.get(id)?.parentId ?? null;
    up;
    up = graph.nodes.get(up)?.parentId ?? null
  ) {
    if (up === top) return depth === 1 ? "child" : "below";
    depth++;
  }
  return null;
}

/** Whether `from` names `to` in its body, links or materials; Card sources do not count. */
function names(graph: Graph, from: string, to: string): boolean {
  return !!graph.nodes
    .get(to)
    ?.incoming.some((i) => i.from.kind === "node" && i.from.id === from && i.via !== "card-source");
}

/** Whether either Node names the other. */
const linked = (graph: Graph, a: string, b: string) => names(graph, a, b) || names(graph, b, a);

/** The material files and directories a Node names, by Workspace path. */
function pathsOf(graph: Graph, id: string): Set<string> {
  return new Set(
    (graph.nodes.get(id)?.materials ?? []).flatMap((m) =>
      m.kind === "file" && m.workspacePath ? [m.workspacePath] : [],
    ),
  );
}

/** Paths both Nodes name, shown by their last part; a directory keeps its trailing slash. */
function sharedOf(graph: Graph, a: string, b: string): string[] {
  const theirs = pathsOf(graph, b);
  return [...pathsOf(graph, a)]
    .filter((p) => theirs.has(p))
    .map((p) => fileName(p) + (p.endsWith("/") ? "/" : ""))
    .sort();
}

const typeOf = (graph: Graph, id: string) => {
  const n = graph.nodes.get(id);
  return n ? primaryOf(n.type) : null;
};

/** The nearest goal above a Node. */
function goalOf(graph: Graph, id: string): string | null {
  for (
    let up = graph.nodes.get(id)?.parentId ?? null;
    up;
    up = graph.nodes.get(up)?.parentId ?? null
  )
    if (typeOf(graph, up) === "goal") return up;
  return null;
}

/** Prompts right under a goal or linked with it: the rules that hang on it. */
function rulesOf(graph: Graph, goal: string): Set<string> {
  const out = new Set<string>();
  for (const id of graph.nodes.get(goal)?.childIds ?? [])
    if (typeOf(graph, id) === "prompt") out.add(id);
  for (const n of graph.nodes.values())
    if (primaryOf(n.type) === "prompt" && linked(graph, goal, n.id)) out.add(n.id);
  return out;
}

export function verifyOf(
  graph: Graph,
  compared: Comparisons,
  goal: string,
  output: string,
): Verify {
  const g = graph.nodes.get(goal),
    o = graph.nodes.get(output);
  let under: Verify["under"] = below(graph, output, goal) ?? "none";
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

export function constrainOf(graph: Graph, goal: string, prompt: string): Constrain {
  return {
    kind: "constrain",
    goal,
    prompt,
    on: below(graph, prompt, goal) ?? (linked(graph, goal, prompt) ? "link" : "none"),
    shared: sharedOf(graph, goal, prompt),
  };
}

export function contrastOf(
  graph: Graph,
  prompt: string,
  output: string,
  times: Times = noTimes,
): Contrast {
  const rule = times.get(prompt),
    told = times.get(output);
  const contrast: Contrast = {
    kind: "contrast",
    prompt,
    output,
    cites: names(graph, output, prompt),
  };
  if (!rule || !told) return contrast;
  const a = Date.parse(rule.contentChangedAt ?? ""),
    b = Date.parse(told.recordedAt ?? "");
  contrast.order =
    Number.isNaN(a) || Number.isNaN(b) ? null : a < b ? "before" : a > b ? "after" : "same";
  return contrast;
}

export function overlapOf(graph: Graph, a: string, b: string): Overlap {
  const theirs = rulesOf(graph, b);
  return {
    kind: "overlap",
    a,
    b,
    family: below(graph, b, a) ? "a" : below(graph, a, b) ? "b" : null,
    shared: sharedOf(graph, a, b),
    rules: [...rulesOf(graph, a)].filter((id) => theirs.has(id)).sort(),
  };
}

export const governOf = (graph: Graph, a: string, b: string): Govern => ({
  kind: "govern",
  a,
  b,
  shared: sharedOf(graph, a, b),
});

export function sequenceOf(graph: Graph, a: string, b: string, times: Times = noTimes): Sequence {
  // When each was last recorded or confirmed, once Core has said so for both; else when it was written.
  const recorded = !!times.get(a)?.recordedAt && !!times.get(b)?.recordedAt;
  const at = (id: string) => {
    const t = recorded ? times.get(id)!.recordedAt : graph.nodes.get(id)?.outputAt;
    return t ? Date.parse(t) : NaN;
  };
  const ta = at(a),
    tb = at(b);
  const pa = pathsOf(graph, a),
    pb = pathsOf(graph, b);
  const name = (p: string) => fileName(p) + (p.endsWith("/") ? "/" : "");
  return {
    kind: "sequence",
    a,
    b,
    goals: [goalOf(graph, a), goalOf(graph, b)],
    first: Number.isNaN(ta) || Number.isNaN(tb) ? null : ta < tb ? "a" : tb < ta ? "b" : "same",
    onlyA: [...pa]
      .filter((p) => !pb.has(p))
      .map(name)
      .sort(),
    onlyB: [...pb]
      .filter((p) => !pa.has(p))
      .map(name)
      .sort(),
    both: [...pa].filter((p) => pb.has(p)).length,
  };
}

export const loopOf = (graph: Graph, goal: string, prompt: string, output: string): Loop => ({
  kind: "loop",
  goal,
  prompt,
  output,
  ruleOn: !!below(graph, prompt, goal) || linked(graph, goal, prompt),
  evidence: !!below(graph, output, goal),
  cites: names(graph, output, prompt),
});

/** The outputs among `members` that react with a goal there, whose comparisons the reactions need. */
export function outputsToCompare(graph: Graph, members: readonly string[]): string[] {
  const typed = (type: string) => members.filter((id) => typeOf(graph, id) === type);
  return typed("goal").length ? typed("output") : [];
}

/** Every reaction between two cards, by their types; the same two cards in either order give the same. */
export function pairOf(
  graph: Graph,
  compared: Comparisons,
  x: string,
  y: string,
  times: Times = noTimes,
): Reaction | null {
  const tx = typeOf(graph, x),
    ty = typeOf(graph, y);
  if (!tx || !ty) return null;
  const by = (type: string) => (tx === type ? x : y);
  const key = [tx, ty].sort().join("+");
  switch (key) {
    case "goal+output":
      return verifyOf(graph, compared, by("goal"), by("output"));
    case "goal+prompt":
      return constrainOf(graph, by("goal"), by("prompt"));
    case "output+prompt":
      return contrastOf(graph, by("prompt"), by("output"), times);
    case "goal+goal":
      return overlapOf(graph, x, y);
    case "prompt+prompt":
      return governOf(graph, x, y);
    case "output+output":
      return sequenceOf(graph, x, y, times);
  }
  return null;
}

const ORDER: Kind[] = ["loop", "verify", "constrain", "contrast", "overlap", "govern", "sequence"];

/**
 * Whether a reaction is listed in full. A goal and an output always say whether one is the other's
 * evidence; other pairs that share nothing are only counted.
 */
export const listed = (r: Reaction) => r.kind === "verify" || matters(r);

/** Every reaction among selected topics: the closed loops first, then each pair by its recipe. */
export function reactionsIn(
  graph: Graph,
  compared: Comparisons,
  members: readonly string[],
  times: Times = noTimes,
): Reaction[] {
  const ids = members.filter((id) => graph.nodes.has(id));
  const out: Reaction[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const r = pairOf(graph, compared, ids[i], ids[j], times);
      if (r) out.push(r);
    }
  const of = (type: string) => ids.filter((id) => typeOf(graph, id) === type);
  for (const g of of("goal"))
    for (const p of of("prompt"))
      for (const o of of("output")) {
        const loop = loopOf(graph, g, p, o);
        // Only a rule tied to the goal or the conclusion makes a loop; otherwise it is a goal and its
        // evidence with an unrelated rule beside them, which the pairs already say.
        if (loop.ruleOn || loop.cites) out.push(loop);
      }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** Whether a dragged card would react with another: they share a recipe that has something to say. */
export function reacts(graph: Graph, x: string, y: string): boolean {
  const r = pairOf(graph, noComparisons, x, y);
  return !!r && matters(r);
}
