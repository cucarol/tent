import { comparePaths } from "./repository-imports.js";

/** Cyclic groups of distinct vertices, not an enumeration of individual paths. */
export function dependencyCycles(outgoing: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    onStack = new Set<string>(),
    components: string[][] = [];
  function visit(node: string) {
    indices.set(node, index);
    low.set(node, index++);
    stack.push(node);
    onStack.add(node);
    for (const next of [...outgoing.get(node)!].sort(comparePaths)) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, indices.get(next)!));
    }
    if (indices.get(node) !== low.get(node)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    components.push(component.sort(comparePaths));
  }
  for (const node of [...outgoing.keys()].sort(comparePaths)) if (!indices.has(node)) visit(node);
  return components
    .filter((component) => component.length > 1)
    .sort((a, b) => comparePaths(JSON.stringify(a), JSON.stringify(b)));
}
