import type { Graph } from "../data/store.js";
import { rectOf, type Placed } from "./layout.js";
import { topicLine, type Arranged } from "./arrange.js";

/** Unchanged topics hold their coordinates. New/moved topics find a free row in their new column. */
export function historyLayout(
  previous: { graph: Graph; layout: Arranged },
  graph: Graph,
  layout: Arranged,
): Arranged {
  // Entering another focus changes the projection itself, not the historical facts under one view.
  if (previous.layout.centre.id !== layout.centre.id) return layout;
  const resized = (old: Placed, next: Placed) =>
    old.w !== next.w || old.h !== next.h || old.head !== next.head;
  const unchanged = (id: string) => {
    const before = previous.graph.nodes.get(id),
      after = graph.nodes.get(id);
    return (
      before &&
      after &&
      before.name === after.name &&
      before.type === after.type &&
      before.parentId === after.parentId
    );
  };
  // Font compensation changes occupied space. The fresh arrangement has already made room for it.
  if (
    resized(previous.layout.centre, layout.centre) ||
    [...layout.placed].some(([id, next]) => {
      const old = previous.layout.placed.get(id);
      return old && unchanged(id) && resized(old, next);
    })
  )
    return layout;
  const placed = new Map(layout.placed);
  const topics = new Map(layout.topics);
  const fixed = new Set<string>();
  for (const [id, position] of placed) {
    const old = previous.layout.placed.get(id);
    if (old && unchanged(id)) {
      placed.set(id, { ...position, x: old.x, y: old.y });
      const topic = topics.get(id)!;
      const oldTopic = previous.layout.topics.get(id);
      if (oldTopic) topics.set(id, { ...topic, side: oldTopic.side });
      fixed.add(id);
    }
  }
  const centre = placed.get(layout.centre.id) ?? layout.centre;
  const occupied = [...fixed].map((id) => rectOf(placed.get(id)!));
  if (!fixed.has(centre.id)) occupied.push(rectOf(centre));
  const free = (position: Placed) => {
    let next = position;
    for (;;) {
      const rect = rectOf(next);
      const hits = occupied.filter(
        (other) =>
          rect.x < other.x + other.w + 12 &&
          other.x < rect.x + rect.w + 12 &&
          rect.y < other.y + other.h + 12 &&
          other.y < rect.y + rect.h + 12,
      );
      if (!hits.length) break;
      next = {
        ...next,
        y: Math.max(...hits.map((other) => other.y + other.h)) + 12 + (next.head ?? next.h) / 2,
      };
    }
    occupied.push(rectOf(next));
    return next;
  };
  for (const [id, position] of placed) {
    if (fixed.has(id) || id === centre.id) continue;
    placed.set(id, free(position));
  }
  const summaries = layout.summaries.map((summary) => ({ ...summary, at: free(summary.at) }));
  const all = new Map([
    ...placed,
    [centre.id, centre] as const,
    ...summaries.map((summary) => [summary.at.id, summary.at] as const),
  ]);
  const lines = layout.lines.map((line) => {
    const from = all.get(line.source)!,
      to = all.get(line.target)!;
    const side =
      topics.get(line.target)?.side ?? summaries.find((s) => s.at.id === line.target)!.topic.side;
    return topicLine(from, to, side);
  });
  return { ...layout, placed, centre, topics, summaries, lines };
}
