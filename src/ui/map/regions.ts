// The lines a region draws between its own cards: only relations Tent already records, one style each.
// Nothing here judges what a relation means; that is for the Agent. Rules: Tent Node
// "UI-图谱画模块依赖与状态", "画布是投影；拖在一起形成区域" (cuca and judge 2026-10-16).
import type { Graph } from "../data/store.js";
import { resultNodeIds } from "../data/card-state.js";

export type RegionLineKind = "parent" | "link" | "material" | "code" | "card";
export type RegionLine = {
  from: string;
  to: string;
  kind: RegionLineKind;
  /** Shared file names, for a material line. */
  files?: string[];
  /** Import count, for a code line. */
  imports?: number;
  /** Card titles, for a Card line. */
  cards?: string[];
};
/** Code imports between Nodes with code directories, as the service reads them. */
export type CodeEdge = { from: string; to: string; imports: number };

const fileName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * Relations among `members`: up and down the tree, references in the body or as materials, material
 * files they share, code imports, and outputs a Card brought back, or Nodes its returned result names, to the cards it was sent with.
 * Given `outside`, the same relations between a member and one of those cards instead.
 */
export function regionLines(
  graph: Graph,
  members: readonly string[],
  upOf: (id: string) => string | null,
  code: readonly CodeEdge[] = [],
  outside?: readonly string[],
): RegionLine[] {
  const here = new Set(members);
  const there = new Set(outside);
  const all = outside ? [...members, ...outside.filter((id) => !here.has(id))] : members;
  const ok = (a: string, b: string) =>
    outside
      ? (here.has(a) && there.has(b) && !here.has(b)) ||
        (here.has(b) && there.has(a) && !here.has(a))
      : here.has(a) && here.has(b);
  const out = new Map<string, RegionLine>();
  const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const family = new Set<string>();
  const add = (line: RegionLine) => {
    if (line.from === line.to || !ok(line.from, line.to)) return;
    const key = `${line.kind}:${line.kind === "material" ? pair(line.from, line.to) : `${line.from}>${line.to}`}`;
    const had = out.get(key);
    if (!had) out.set(key, line);
    else if (line.cards) had.cards = [...new Set([...(had.cards ?? []), ...line.cards])];
  };

  for (const id of all) {
    const up = upOf(id);
    if (up && ok(up, id)) {
      add({ from: up, to: id, kind: "parent" });
      family.add(pair(up, id));
    }
  }
  for (const id of all) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    for (const i of n.incoming)
      if (i.from.kind === "node" && i.via !== "card-source" && !family.has(pair(i.from.id, id)))
        add({ from: i.from.id, to: id, kind: "link" });
  }
  // Files more than one member names as material, by Workspace path.
  const byFile = new Map<string, string[]>();
  for (const id of all)
    for (const m of graph.nodes.get(id)?.materials ?? [])
      if (m.kind === "file" && m.workspacePath) {
        const list = byFile.get(m.workspacePath) ?? [];
        if (!list.includes(id)) list.push(id);
        byFile.set(m.workspacePath, list);
      }
  const shared = new Map<string, { from: string; to: string; files: string[] }>();
  for (const [path, ids] of byFile)
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        if (!ok(ids[i], ids[j])) continue;
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const s = shared.get(pair(a, b)) ?? { from: a, to: b, files: [] };
        s.files.push(fileName(path));
        shared.set(pair(a, b), s);
      }
  for (const s of shared.values()) add({ ...s, kind: "material", files: s.files.sort() });
  for (const e of code) add({ from: e.from, to: e.to, kind: "code", imports: e.imports });
  // What came back through a Card: outputs that name it as their source, and Nodes its result names.
  const answers = new Map<string, string[]>();
  for (const id of all)
    for (const m of graph.nodes.get(id)?.materials ?? [])
      if (m.kind === "card" && m.id) answers.set(m.id, [...(answers.get(m.id) ?? []), id]);
  for (const c of graph.snapshot.cards) {
    const sent = c.sources.flatMap((s) => (s.kind === "node" && s.id ? [s.id] : []));
    for (const o of new Set([...(answers.get(c.id) ?? []), ...resultNodeIds(c.result)]))
      for (const s of sent) add({ from: o, to: s, kind: "card", cards: [c.title] });
  }
  return [...out.values()];
}

/**
 * Cards among `outside` directly related to a region's members, with how: what the region's title
 * offers to pull in when looking one layer out.
 */
export function reachOut(
  graph: Graph,
  members: readonly string[],
  outside: readonly string[],
  upOf: (id: string) => string | null,
  code: readonly CodeEdge[] = [],
): Map<string, RegionLine[]> {
  const here = new Set(members);
  const out = new Map<string, RegionLine[]>();
  for (const line of regionLines(graph, members, upOf, code, outside)) {
    const far = here.has(line.from) ? line.to : line.from;
    out.set(far, [...(out.get(far) ?? []), line]);
  }
  return out;
}
