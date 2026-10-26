import type {
  Snapshot,
  SnapshotCard,
  SnapshotCommit,
  SnapshotNode,
  SnapshotRef,
  SnapshotRole,
} from "./types.js";
import type { WorkspaceMap, WorkspaceMapNode } from "../../core/read/workspace-map.js";
import { t } from "../i18n.js";
import { api, describe } from "./api.js";
import { isDraft } from "./drafts.js";
import { cardStage } from "./card-state.js";

export type Primary = "goal" | "prompt" | "output";

/** Node types are exactly goal, prompt or output; anything else renders as prompt. */
export function primaryOf(type: string): Primary {
  return type === "goal" || type === "output" ? type : "prompt";
}

export type NodeState = {
  recent: boolean; // changed since the viewer's first visit and not opened since
  pendingCards: string[]; // pending Cards that use this Node as a source
  drift: boolean; // a pending Card pinned an older version
  deprecated: boolean;
  references: number; // incoming references
};

/** What this viewer has seen: changes after `baseline` count as new until the Node is opened at that version. */
export type Visits = { baseline: number; seen: Record<string, string> };

export type Graph = ReturnType<typeof buildGraph>;

/**
 * Indices and derived states over one snapshot; recomputed when the snapshot or visits change. Until
 * `detailed`, the snapshot is the map alone (see `mapSnapshot`): what it leaves out is not yet known, so
 * views say they are reading rather than that there is none.
 */
export function buildGraph(snapshot: Snapshot, visits: Visits | null = null, detailed = true) {
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const roles = new Map(snapshot.roles.map((r) => [r.id, r]));
  const cards = new Map(snapshot.cards.map((c) => [c.id, c]));
  const commits = new Map(snapshot.commits.map((c) => [c.hash, c]));
  const waiting = (c: SnapshotCard) => c.state === "pending" && !isDraft(c);

  const states = new Map<string, NodeState>();
  for (const n of snapshot.nodes) {
    const last = n.history[0] ? commits.get(n.history[0]) : undefined;
    states.set(n.id, {
      recent:
        !!visits &&
        !!last &&
        Date.parse(last.date) > visits.baseline &&
        visits.seen[n.id] !== last.hash,
      pendingCards: snapshot.cards
        .filter((c) => waiting(c) && c.sources.some((s) => s.id === n.id))
        .map((c) => c.id),
      // Only a Card still waiting to be received can hand someone an outdated version.
      drift: n.incoming.some(
        (i) =>
          i.via === "card-source" &&
          i.changedSince &&
          !!cards.get(i.from.id) &&
          waiting(cards.get(i.from.id)!),
      ),
      deprecated: n.status === "deprecated",
      references: n.incoming.length,
    });
  }

  const counts = { goal: 0, prompt: 0, output: 0 } as Record<Primary, number>;
  for (const n of snapshot.nodes) counts[primaryOf(n.type)]++;

  // Siblings read goal, then prompt, then output: what we want, how, and what came of it.
  const RANK: Record<Primary, number> = { goal: 0, prompt: 1, output: 2 };
  const kids = new Map<string | null, SnapshotNode[]>();
  for (const n of snapshot.nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const list of kids.values())
    list.sort((a, b) => RANK[primaryOf(a.type)] - RANK[primaryOf(b.type)]);
  const childrenOf = (parentId: string | null): SnapshotNode[] => kids.get(parentId) ?? [];

  // Roles connected to each Node in either direction.
  const nodeRoles = new Map<string, SnapshotRole[]>();
  for (const r of snapshot.roles) {
    const ids = new Set([
      ...r.links.flatMap((l) => (l.ref?.kind === "node" ? [l.ref.id] : [])),
      ...r.incoming.flatMap((i) => (i.from.kind === "node" ? [i.from.id] : [])),
    ]);
    for (const id of ids) nodeRoles.set(id, [...(nodeRoles.get(id) ?? []), r]);
  }
  const rolesOf = (nodeId: string): SnapshotRole[] => nodeRoles.get(nodeId) ?? [];

  // Where each Node went in published Cards, lane by lane: Roles in their order, then the public area.
  const lanes = new Map<string, Map<string, Hand>>();
  for (const c of snapshot.cards) {
    if (isDraft(c)) continue;
    const lane = c.receivedBy ?? c.target ?? "";
    const waits = c.state === "pending";
    const counted = new Set<string>();
    for (const s of c.sources) {
      if (!s.id || !nodes.has(s.id)) continue;
      const byLane = lanes.get(s.id) ?? new Map<string, Hand>();
      lanes.set(s.id, byLane);
      const hand = byLane.get(lane) ?? {
        lane,
        cards: 0,
        waiting: 0,
        doing: 0,
        old: false,
      };
      byLane.set(lane, hand);
      // A Card can repeat a Node at different versions; count the Card, but inspect every version.
      if (!counted.has(s.id)) {
        if (waits) hand.waiting++;
        else hand.cards++;
        if (cardStage(c) === "doing") hand.doing++;
        counted.add(s.id);
      }
      if (waits && s.changedSince) hand.old = true;
    }
  }
  const laneRank = new Map(snapshot.roles.map((r, i) => [r.id, i]));
  const rank = (lane: string) => (lane ? (laneRank.get(lane) ?? snapshot.roles.length) : Infinity);
  const handed = new Map(
    [...lanes].map(([id, byLane]) => [
      id,
      [...byLane.values()].sort((a, b) => rank(a.lane) - rank(b.lane)),
    ]),
  );
  /** Who this Node was handed to in published Cards, and what still waits. */
  const handedTo = (nodeId: string): Hand[] => handed.get(nodeId) ?? [];

  function name(ref: SnapshotRef | null | undefined): string {
    if (!ref) return "";
    if (ref.kind === "node") return nodes.get(ref.id)?.name ?? ref.id;
    if (ref.kind === "role") return roles.get(ref.id)?.title ?? ref.id;
    const card = cards.get(ref.id);
    return card ? cardTitle(card) : ref.id;
  }
  /** The Node or Role a source address names: a path from the Tent root, or one relative to cards/. */
  function refOf(resource: string): SnapshotRef | null {
    const parts: string[] = [];
    const base = resource.startsWith("/") ? [] : ["cards"];
    for (const part of [...base, ...resource.split("/")]) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return snapshot.paths[parts.join("/")] ?? null;
  }
  function exists(ref: SnapshotRef) {
    return ref.kind === "node"
      ? nodes.has(ref.id)
      : ref.kind === "role"
        ? roles.has(ref.id)
        : cards.has(ref.id);
  }
  function lastChange(path: string): SnapshotCommit | undefined {
    return snapshot.commits.find((c) => c.files.some((f) => f.path === path));
  }
  function ancestors(id: string): SnapshotNode[] {
    const out: SnapshotNode[] = [];
    let current = nodes.get(id);
    while (current?.parentId) {
      const parent = nodes.get(current.parentId);
      if (!parent) break;
      out.unshift(parent);
      current = parent;
    }
    return out;
  }
  /** Nodes and Roles directly connected to an object, by any relation. */
  function neighbours(id: string): Set<string> {
    const out = new Set<string>();
    const n = nodes.get(id);
    if (n) {
      if (n.parentId) out.add(n.parentId);
      n.childIds.forEach((c) => out.add(c));
      n.links.forEach((l) => l.ref && out.add(l.ref.id));
      n.materials.forEach((m) => m.id && out.add(m.id));
      n.incoming.forEach((i) => out.add(i.from.id));
    }
    const r = roles.get(id);
    if (r) {
      r.links.forEach((l) => l.ref && out.add(l.ref.id));
      r.incoming.forEach((i) => out.add(i.from.id));
    }
    return out;
  }

  return {
    snapshot,
    detailed,
    nodes,
    roles,
    cards,
    commits,
    states,
    counts,
    name,
    exists,
    refOf,
    lastChange,
    ancestors,
    neighbours,
    childrenOf,
    rolesOf,
    handedTo,
  };
}

/**
 * One lane a Node went to in published Cards: a Role id, or "" for the public area. `cards` counts the
 * Cards received there, `waiting` those still pending, and `old` is set when a waiting one pinned a version
 * the Node has since moved past.
 */
export type Hand = {
  lane: string;
  cards: number;
  waiting: number;
  /** Received Cards still being done: they are to be returned and have not been yet. */
  doing: number;
  old: boolean;
};

export const cardTitle = (c: SnapshotCard) => c.title || t.card.contextOnly(c.sources.length);

export function refKey(ref: SnapshotRef) {
  return `${ref.kind}:${ref.id}`;
}

/** What the map says about a Node that the snapshot does not: explicit expiry and an unreadable header. */
function diagnostics(
  n: WorkspaceMapNode,
): Pick<SnapshotNode, "stale" | "invalid" | "invalidReason"> {
  return {
    ...(n.stale ? { stale: true } : {}),
    ...(n.invalid ? { invalid: true, invalidReason: n.invalidReason } : {}),
  };
}

/**
 * The map as a snapshot to draw the first screen with: every Node in tree order with its name, type, tags,
 * place, explicit expiry and header diagnosis, and the module lines. Bodies, links, materials, history,
 * Cards and Roles come with the full snapshot, read only when something asks for them; the map's own
 * revision stands in until then and is never compared with the full one.
 */
export function mapSnapshot(map: WorkspaceMap): Snapshot {
  return {
    workspace: map.workspace,
    nodes: map.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      path: n.path,
      notePath: n.notePath,
      depth: n.depth,
      type: n.type,
      tags: n.tags,
      status: n.status,
      archived: n.archived,
      description: "",
      body: "",
      parentId: n.parentId,
      childIds: n.childIds,
      links: [],
      materials: [],
      incoming: [],
      history: [],
      ...diagnostics(n),
    })),
    roles: [],
    cards: [],
    commits: [],
    paths: Object.fromEntries(map.nodes.map((n) => [n.notePath, { kind: "node", id: n.id }])),
    modules: map.modules,
  };
}

/** The current map's topology with the last snapshot's document details while its next read is on the way. */
export function withMap(full: Snapshot, map: WorkspaceMap): Snapshot {
  const byId = new Map(full.nodes.map((n) => [n.id, n]));
  const current = mapSnapshot(map);
  const previousPaths = new Set(full.nodes.map((n) => n.notePath));
  return {
    ...full,
    nodes: current.nodes.map((n) => {
      const previous = byId.get(n.id);
      if (!previous) return n;
      return {
        ...previous,
        name: n.name,
        path: n.path,
        notePath: n.notePath,
        depth: n.depth,
        type: n.type,
        tags: n.tags,
        status: n.status,
        archived: n.archived,
        parentId: n.parentId,
        childIds: n.childIds,
        stale: n.stale,
        outputAt: n.stale ? undefined : previous.outputAt,
        invalid: n.invalid,
        invalidReason: n.invalidReason,
      };
    }),
    paths: {
      ...Object.fromEntries(
        Object.entries(full.paths).filter(([path]) => !previousPaths.has(path)),
      ),
      ...current.paths,
    },
    modules: map.modules,
  };
}

export async function loadMap(): Promise<WorkspaceMap> {
  try {
    return await api.map();
  } catch (error) {
    throw new Error(describe(error));
  }
}

export async function loadSnapshot(): Promise<Snapshot> {
  try {
    return (await api.snapshot())!;
  } catch (error) {
    throw new Error(describe(error));
  }
}

export type { SnapshotNode, SnapshotRole, SnapshotCard };
