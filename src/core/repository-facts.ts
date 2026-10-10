import path from "node:path";
import {
  comparePaths,
  extractRepositoryImports,
  isCodeSource,
  isGeneratedSource,
  isImportSource,
  isTestSource,
  type RepositoryImport,
  type RepositorySource,
} from "./repository-imports.js";

export function repositoryDirectoryGraph(
  imports: readonly RepositoryImport[],
  files: readonly string[],
  depth: number,
) {
  if (!Number.isInteger(depth) || depth < 1) throw new Error("Directory depth must be positive");
  const unit = (directory: string) => directory.split("/").slice(0, depth).join("/");
  const nodes = [
    ...new Set(
      files
        .filter((file) => isImportSource(file) && !isTestSource(file))
        .map((file) => unit(path.posix.dirname(file))),
    ),
  ].sort(comparePaths);
  const collected = new Map<
    string,
    { from: string; to: string; imports: number; files: Set<string> }
  >();
  for (const edge of imports) {
    const from = unit(path.posix.dirname(edge.from));
    const to = unit(edge.kind === "directory" ? edge.to : path.posix.dirname(edge.to));
    if (from === to) continue;
    const key = JSON.stringify([from, to]);
    const item = collected.get(key) ?? { from, to, imports: 0, files: new Set<string>() };
    item.imports++;
    item.files.add(edge.from);
    collected.set(key, item);
  }
  for (const edge of collected.values()) {
    if (!nodes.includes(edge.from)) nodes.push(edge.from);
    if (!nodes.includes(edge.to)) nodes.push(edge.to);
  }
  nodes.sort(comparePaths);
  const outgoing = new Map(nodes.map((node) => [node, new Set<string>()]));
  const incoming = new Map(nodes.map((node) => [node, new Set<string>()]));
  for (const edge of collected.values()) {
    outgoing.get(edge.from)!.add(edge.to);
    incoming.get(edge.to)!.add(edge.from);
  }
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
  for (const node of nodes) if (!indices.has(node)) visit(node);
  const componentOf = new Map<string, number>();
  components.forEach((component, i) => component.forEach((node) => componentOf.set(node, i)));
  const parents = components.map(() => new Set<number>());
  for (const edge of collected.values()) {
    const from = componentOf.get(edge.from)!,
      to = componentOf.get(edge.to)!;
    if (from !== to) parents[to]!.add(from);
  }
  const layers = new Map<number, number>();
  function layer(component: number): number {
    if (!layers.has(component))
      layers.set(
        component,
        Math.max(0, ...[...parents[component]!].map((parent) => layer(parent) + 1)),
      );
    return layers.get(component)!;
  }
  return {
    depth,
    entries: nodes.filter((node) => incoming.get(node)!.size === 0),
    layers: nodes
      .map((directory) => ({ directory, layer: layer(componentOf.get(directory)!) }))
      .sort((a, b) => a.layer - b.layer || comparePaths(a.directory, b.directory)),
    cycles: components
      .filter((component) => component.length > 1)
      .sort((a, b) => comparePaths(JSON.stringify(a), JSON.stringify(b))),
    edges: [...collected.values()]
      .map((edge) => ({ ...edge, files: [...edge.files].sort(comparePaths) }))
      .sort(
        (a, b) => b.imports - a.imports || comparePaths(a.from, b.from) || comparePaths(a.to, b.to),
      ),
  };
}

/** Prefix counts describe file names, not guessed module boundaries. */
export function filePrefixGroups(files: readonly string[]) {
  const groups = new Map<string, number>();
  for (const file of files) {
    const name = path.posix.basename(file);
    const match = /^([^_.-]+[-_])/.exec(name);
    if (!match) continue;
    const prefix = path.posix.join(path.posix.dirname(file), match[1]!);
    groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
  }
  return [...groups]
    .filter(([, count]) => count >= 2)
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || comparePaths(a.prefix, b.prefix));
}

export function repositoryFacts(sources: readonly RepositorySource[]) {
  const files = [...new Set(sources.map((source) => source.path))].sort(comparePaths);
  const imports = extractRepositoryImports(sources);
  const generated = new Map<string, string[]>();
  const flat = new Map<string, string[]>();
  for (const file of files) {
    if (isGeneratedSource(file)) {
      const match = /^(.*?(?:^|\/)(?:gen|generated|__generated__))\//.exec(file);
      const dir = match?.[1] ?? path.posix.dirname(file);
      const group = generated.get(dir) ?? [];
      group.push(file);
      generated.set(dir, group);
    }
    if (isCodeSource(file) && !isGeneratedSource(file)) {
      const dir = path.posix.dirname(file),
        group = flat.get(dir) ?? [];
      group.push(file);
      flat.set(dir, group);
    }
  }
  return {
    imports,
    dependencies: [1, 2].map((depth) => repositoryDirectoryGraph(imports.edges, files, depth)),
    guidanceFiles: files.filter(
      (file) =>
        /(^|\/)(AGENTS|CLAUDE|GEMINI|CONTRIBUTING|ARCHITECTURE|DESIGN|HACKING)(\.md|\.rst|\.txt)?$/i.test(
          file,
        ) ||
        /(^|\/)doc\.go$/.test(file) ||
        /^\.cursor\/rules\//.test(file) ||
        /^([^/]+\/){0,2}README\.(md|rst|txt)$/i.test(file),
    ),
    generatedDirectories: [...generated]
      .map(([directory, files]) => ({ directory, files }))
      .sort((a, b) => b.files.length - a.files.length || comparePaths(a.directory, b.directory)),
    flatDirectories: [...flat]
      .filter(([, files]) => files.length > 20)
      .map(([directory, files]) => ({
        directory,
        codeFiles: files.length,
        groups: filePrefixGroups(files),
      }))
      .sort((a, b) => b.codeFiles - a.codeFiles || comparePaths(a.directory, b.directory)),
  };
}
