import path from "node:path";
import { dependencyCycles } from "../base/dependency-cycles.js";
import { comparePaths, isCodeSource, isTestSource } from "../base/repository-imports.js";
import type { RepositoryImport } from "../base/repository-imports.js";
import type { ModuleMapMaterial } from "./module-map.js";

export const DRAFT_CODE_FILES = 10;
export type DraftUnit = {
  key: string;
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

/** Flat groups are consecutive in a topological order, so packing cannot invent an import cycle. */
function flatGroups(files: string[], imports: readonly RepositoryImport[]): string[][] {
  const buckets = new Map<string, string[]>();
  for (const file of files) {
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
  for (const cycle of dependencyCycles(outgoing)) {
    const key = cycle[0]!;
    buckets.set(
      key,
      cycle.flatMap((member) => buckets.get(member)!),
    );
    for (const member of cycle.slice(1)) buckets.delete(member);
    for (const file of buckets.get(key)!) owner.set(file, key);
  }
  const graph = new Map([...buckets.keys()].map((key) => [key, new Set<string>()]));
  const incoming = new Map([...buckets.keys()].map((key) => [key, 0]));
  for (const edge of imports) {
    const from = owner.get(edge.from),
      to = edge.kind === "file" && owner.get(edge.to);
    if (from && to && from !== to && !graph.get(from)!.has(to)) {
      graph.get(from)!.add(to);
      incoming.set(to, incoming.get(to)! + 1);
    }
  }
  const ready = new Set([...incoming].filter(([, count]) => count === 0).map(([key]) => key));
  const groups: string[][] = [];
  let group: string[] = [],
    keys: string[] = [];
  const affinity = (key: string) => keys.filter((member) => graph.get(member)!.has(key)).length;
  const filenameGroup = (key: string) => {
    const members = buckets.get(key)!;
    if (!members.every((file) => /\.(go|java)$/.test(file))) return undefined;
    return path.posix
      .basename(members[0]!)
      .replace(/\.[^.]+$/, "")
      .split(/[-_]|(?<=[a-z])(?=[A-Z])/)[0];
  };
  while (ready.size) {
    const candidates = [...ready].sort((a, b) => affinity(b) - affinity(a) || comparePaths(a, b));
    const key = candidates[0]!,
      members = buckets.get(key)!;
    const named = filenameGroup(key),
      previous = keys.length ? filenameGroup(keys[0]!) : undefined;
    if (
      group.length &&
      (group.length + members.length > DRAFT_CODE_FILES ||
        (named && previous && named !== previous))
    ) {
      groups.push(group);
      group = [];
      keys = [];
      continue;
    }
    group.push(...members);
    keys.push(key);
    ready.delete(key);
    for (const next of graph.get(key)!) {
      incoming.set(next, incoming.get(next)! - 1);
      if (!incoming.get(next)) ready.add(next);
    }
  }
  if (group.length) groups.push(group);
  return groups.map(ordered);
}

/** Keep real directory layers; only a large directory's direct code needs import grouping. */
export function draftDirectoryUnits(
  directory: string,
  files: string[],
  imports: readonly RepositoryImport[],
  parentKey?: string,
): DraftUnit[] {
  const unit: DraftUnit = {
    key: directory,
    materials: [draftMaterial(directory + "/")],
    parentKey,
  };
  const sources = files.filter(code);
  if (sources.length <= DRAFT_CODE_FILES) return [unit];
  const children = ordered(
    sources
      .map((file) => file.slice(directory.length + 1))
      .filter((file) => file.includes("/"))
      .map((file) => directory + "/" + file.split("/")[0]),
  );
  const direct = sources.filter((file) => path.posix.dirname(file) === directory);
  const groups = flatGroups(direct, imports);
  // One indivisible import cycle is already represented by its directory.
  if (!children.length && groups.length <= 1) return [unit];
  return [
    unit,
    ...children.flatMap((child) =>
      draftDirectoryUnits(
        child,
        files.filter((file) => file.startsWith(child + "/")),
        imports,
        unit.key,
      ),
    ),
    ...draftFlatUnits(groups, files, unit.key),
  ];
}

function draftFlatUnits(groups: string[][], files: string[], parentKey: string): DraftUnit[] {
  return groups.map((members): DraftUnit => {
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
    return { key: members[0]!, materials, parentKey };
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
