import path from "node:path";
import { dependencyCycles } from "../base/dependency-cycles.js";
import { comparePaths, isCodeSource, isTestSource } from "../base/repository-imports.js";
import type { RepositoryImport } from "../base/repository-imports.js";
import type { ModuleMapMaterial } from "./module-map.js";

export const DRAFT_CODE_FILES = 10;
export type DraftUnit = {
  key: string;
  name?: string;
  materials: ModuleMapMaterial[];
  parentKey?: string;
};
const ordered = (values: Iterable<string>) => [...new Set(values)].sort(comparePaths);
const code = (file: string) => isCodeSource(file) && !isTestSource(file);
export const draftMaterial = (value: string, structure = true): ModuleMapMaterial => ({
  path: value.endsWith("/") ? value.slice(0, -1) : value,
  kind: value.endsWith("/") ? "directory" : "prefix",
  ...(structure ? { track: "structure" as const } : {}),
});
export const draftPrefix = (file: string) =>
  file.slice(0, file.length - path.posix.extname(file).length).replace(/\.pb$/, "") + ".";

type FlatGroup = { files: string[]; name: string };
const stemOf = (file: string) => path.posix.basename(draftPrefix(file)).slice(0, -1);
const familyOf = (file: string) => stemOf(file).split(/[-_]|(?<=[a-z])(?=[A-Z])/)[0]!;

/** Cut shared dependencies before following each entry, never pack unrelated entries together. */
function flatGroups(files: string[], imports: readonly RepositoryImport[]): FlatGroup[] {
  const buckets = new Map<string, string[]>();
  for (const file of ordered(files)) {
    const key = draftPrefix(file).replace(/_pb\.$/, ".");
    buckets.set(key, [...(buckets.get(key) ?? []), file]);
  }
  const owner = new Map([...buckets].flatMap(([key, members]) => members.map((f) => [f, key])));
  const outgoing = new Map([...buckets.keys()].map((key) => [key, new Set<string>()]));
  for (const edge of imports) {
    const from = owner.get(edge.from),
      to = edge.kind === "file" && owner.get(edge.to);
    if (from && to && from !== to) outgoing.get(from)!.add(to);
  }
  const cycles = dependencyCycles(outgoing);
  const cyclic = new Set(cycles.flat());
  const components = [
    ...cycles,
    ...[...buckets.keys()].filter((key) => !cyclic.has(key)).map((key) => [key]),
  ];
  const componentOf = new Map(
    components.flatMap((component, i) => component.map((key) => [key, i] as const)),
  );
  const graph = components.map(() => new Set<number>());
  const incoming = components.map(() => new Set<number>());
  for (const [from, targets] of outgoing)
    for (const to of targets) {
      const a = componentOf.get(from)!,
        b = componentOf.get(to)!;
      if (a !== b) {
        graph[a]!.add(b);
        incoming[b]!.add(a);
      }
    }
  const roots = components.flatMap((_, i) => (!incoming[i]!.size && graph[i]!.size ? [i] : []));
  const reachedBy = components.map(() => new Set<number>());
  for (const root of roots) {
    const pending = [...graph[root]!];
    while (pending.length) {
      const current = pending.pop()!;
      if (reachedBy[current]!.has(root)) continue;
      reachedBy[current]!.add(root);
      pending.push(...graph[current]!);
    }
  }
  // A strict majority of entry components reaches these dependencies. Count each entry once,
  // including through intermediate helpers; duplicate imports must not turn a helper into a hub.
  const shared = new Set(
    components.flatMap((_, i) =>
      roots.length > 1 && reachedBy[i]!.size > roots.length / 2 ? [i] : [],
    ),
  );
  const membersOf = (ids: number[]) =>
    ordered(ids.flatMap((i) => components[i]!.flatMap((key) => buckets.get(key)!)));
  const groups: FlatGroup[] = [];
  const add = (ids: number[], name: string) => {
    const members = membersOf(ids);
    if (members.length <= DRAFT_CODE_FILES) {
      groups.push({ files: members, name });
      return;
    }
    // Preserve bounded cycles and generated-source families. An oversized cycle is split,
    // but size splitting stays within this evidenced group rather than borrowing other entries.
    const units = ids
      .flatMap((i) => {
        const keys = components[i]!;
        return membersOf([i]).length <= DRAFT_CODE_FILES ? [keys] : keys.map((key) => [key]);
      })
      .sort((a, b) => comparePaths(a[0]!, b[0]!));
    let chunk: string[] = [];
    const chunks: string[][] = [];
    for (const keys of units) {
      const next = keys.flatMap((key) => buckets.get(key)!);
      if (chunk.length && chunk.length + next.length > DRAFT_CODE_FILES) {
        chunks.push(chunk);
        chunk = [];
      }
      chunk.push(...next);
    }
    if (chunk.length) chunks.push(chunk);
    chunks.forEach((chunk, i) => groups.push({ files: ordered(chunk), name: `${name} ${i + 1}` }));
  };
  if (shared.size) add([...shared], "Shared dependencies");
  const remaining = new Set(components.map((_, i) => i).filter((i) => !shared.has(i)));
  const fallback = new Map<string, number[]>();
  while (remaining.size) {
    const start = remaining.values().next().value!;
    const connected: number[] = [],
      pending = [start];
    while (pending.length) {
      const current = pending.pop()!;
      if (!remaining.delete(current)) continue;
      connected.push(current);
      pending.push(...graph[current]!, ...incoming[current]!);
    }
    const members = membersOf(connected);
    const linked = connected.length > 1 || components[start]!.length > 1;
    if (!linked) {
      const family = familyOf(members[0]!);
      fallback.set(family, [...(fallback.get(family) ?? []), start]);
      continue;
    }
    const entries = connected.filter(
      (i) => ![...incoming[i]!].some((from) => connected.includes(from)),
    );
    const entryFiles = membersOf(entries.length ? entries : connected);
    add(connected, ordered(entryFiles.map(stemOf)).join(" and "));
  }
  // With no separating import evidence, merge prefix-related stems (foo plus foo-hud).
  for (const [name, ids] of fallback) add(ids, name);
  return groups.sort((a, b) => comparePaths(a.name, b.name));
}

/** Keep real directory layers; only a large directory's direct code needs import grouping. */
export function draftDirectoryUnits(
  directory: string,
  files: string[],
  imports: readonly RepositoryImport[],
  parentKey?: string,
  productDirectories: readonly string[] = [],
): DraftUnit[] {
  const unit: DraftUnit = {
    key: directory,
    materials: [draftMaterial(directory + "/")],
    parentKey,
  };
  const sources = files.filter(code);
  const large = sources.length > DRAFT_CODE_FILES;
  const children = ordered(
    [
      ...productDirectories.filter((child) => child.startsWith(directory + "/")),
      ...(large ? sources.filter((file) => path.posix.dirname(file) !== directory) : []),
    ].map((child) => directory + "/" + child.slice(directory.length + 1).split("/")[0]),
  );
  const direct = sources.filter((file) => path.posix.dirname(file) === directory);
  const groups = large ? flatGroups(direct, imports) : [];
  // A single bounded group (or generated-source family) is represented by its directory.
  if (!children.length && groups.length <= 1) return [unit];
  return [
    unit,
    ...children.flatMap((child) =>
      draftDirectoryUnits(
        child,
        files.filter((file) => file.startsWith(child + "/")),
        imports,
        unit.key,
        productDirectories,
      ),
    ),
    ...draftFlatUnits(groups, files, unit.key),
  ];
}

function draftFlatUnits(groups: FlatGroup[], files: string[], parentKey: string): DraftUnit[] {
  return groups.map(({ files: members, name }): DraftUnit => {
    const prefixes = ordered(members.map(draftPrefix));
    const materials: ModuleMapMaterial[] = prefixes.map((prefix) => draftMaterial(prefix));
    // Nearby Python/Go/JS tests stay with their source even when their names use an underscore.
    const stems = new Set(
      members.map((file) => path.posix.basename(file, path.posix.extname(file))),
    );
    for (const file of files.filter(
      (file) => path.posix.dirname(file) === path.posix.dirname(members[0]!) && isTestSource(file),
    )) {
      const stem = path.posix
        .basename(file, path.posix.extname(file))
        .replace(/^test_/, "")
        .replace(/[._-](test|spec)$/, "");
      if (stems.has(stem) && !prefixes.some((prefix) => file.startsWith(prefix)))
        materials.push({ path: file, kind: "file" });
    }
    return { key: members[0]!, name, materials, parentKey };
  });
}

export function draftRootPackageUnits(
  files: string[],
  imports: readonly RepositoryImport[],
): DraftUnit[] {
  const sources = files.filter(
    (file) => !file.includes("/") && file.endsWith(".go") && !isTestSource(file),
  );
  const key = "Root Go package";
  if (sources.length <= DRAFT_CODE_FILES)
    return [{ key, materials: sources.map((file) => draftMaterial(draftPrefix(file))) }];
  return [
    { key, materials: [{ path: ".", kind: "directory", track: "structure" }] },
    ...draftFlatUnits(flatGroups(sources, imports), files, key),
  ];
}
