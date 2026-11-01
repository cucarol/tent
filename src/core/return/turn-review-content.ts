import type { StopMaterialIndex } from "./stop-material-index.js";
import { turnReviewDocument, turnReviewHeaderDigest } from "./turn-review-document.js";
import type { TurnReviewModule, TurnReviewNode } from "./tool-turn-review.js";

/** Current document observations only; this port has no history or mutation methods. */
export type TurnReviewContentFs = {
  readFile(path: string): Promise<string>;
  observationScope?<T>(action: () => Promise<T>): Promise<T>;
};

/** Reassign this Hook's already-observed bodies after claim competition, without another read. */
export function reprojectTurnReviewContent(
  index: StopMaterialIndex,
  originalLoadedModules: readonly TurnReviewModule[],
  excludedNodeIds: ReadonlySet<string> = new Set(),
): TurnReviewModule[] {
  const indexed = new Map(index.nodes.map((node) => [node.nodeId, node]));
  const bodies = new Map<string, TurnReviewNode>();
  for (const owner of originalLoadedModules)
    for (const node of [owner, ...(owner.rules ?? [])])
      if (!bodies.has(node.nodeId))
        bodies.set(node.nodeId, {
          nodeId: node.nodeId,
          names: node.names,
          path: node.path,
          body: node.body,
        });
  const owners: TurnReviewModule[] = [];
  const seen = new Set<string>();
  for (const owner of originalLoadedModules)
    if (!excludedNodeIds.has(owner.nodeId) && !seen.has(owner.nodeId)) {
      seen.add(owner.nodeId);
      owners.push(owner);
    }
  return owners.map((owner) => {
    const rules: TurnReviewNode[] = [];
    for (const id of indexed.get(owner.nodeId)?.ruleNodeIds ?? []) {
      if (seen.has(id) || excludedNodeIds.has(id)) continue;
      const rule = bodies.get(id);
      if (!rule) continue;
      seen.add(id);
      rules.push(rule);
    }
    return { ...owner, rules };
  });
}

/** Read only selected owners and their prepared governing rules; stale identities stay silent. */
export async function loadTurnReviewContent(
  currentFs: TurnReviewContentFs,
  index: StopMaterialIndex,
  modules: readonly TurnReviewModule[],
  excludedNodeIds: ReadonlySet<string> = new Set(),
): Promise<TurnReviewModule[]> {
  const run = async () => {
    const indexed = new Map(index.nodes.map((node) => [node.nodeId, node]));
    const observed = new Map<string, Promise<TurnReviewNode | undefined>>();
    const read = (id: string): Promise<TurnReviewNode | undefined> => {
      if (excludedNodeIds.has(id)) return Promise.resolve(undefined);
      const previous = observed.get(id);
      if (previous) return previous;
      const pending = (async () => {
        const node = indexed.get(id);
        if (!node?.headerDigest || !node.path.startsWith(".tent/")) return;
        try {
          const raw = await currentFs.readFile(node.path.slice(".tent/".length));
          const { header, body } = turnReviewDocument(raw);
          if (turnReviewHeaderDigest(header) !== node.headerDigest) return;
          return {
            nodeId: node.nodeId,
            names: node.names,
            path: node.path,
            body,
          };
        } catch {
          // Missing, invalid, replaced and unreadable documents cannot support advice.
          return;
        }
      })();
      observed.set(id, pending);
      return pending;
    };
    const owners: TurnReviewModule[] = [];
    for (const module of modules) {
      if (owners.some((owner) => owner.nodeId === module.nodeId)) continue;
      const owner = await read(module.nodeId);
      if (owner) owners.push({ ...owner, files: module.files });
    }
    const seen = new Set(owners.map((owner) => owner.nodeId));
    for (const owner of owners) {
      const rules: TurnReviewNode[] = [];
      for (const id of indexed.get(owner.nodeId)?.ruleNodeIds ?? []) {
        if (seen.has(id)) continue;
        const rule = await read(id);
        if (!rule) continue;
        seen.add(id);
        rules.push(rule);
      }
      owner.rules = rules;
    }
    return reprojectTurnReviewContent(index, owners, excludedNodeIds);
  };
  return currentFs.observationScope ? currentFs.observationScope(run) : run();
}
