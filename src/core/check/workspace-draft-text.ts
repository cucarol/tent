import path from "node:path";
import { comparePaths, isCodeSource, isTestSource } from "../base/repository-imports.js";
import { MODULE_MAP_THRESHOLDS, checkModuleMap, type ModuleMapCommit } from "./module-map.js";
import { DRAFT_CODE_FILES, draftMaterial, type DraftUnit } from "./workspace-draft-groups.js";

const ordered = (files: Iterable<string>) => [...new Set(files)].sort(comparePaths);
const stem = (file: string) => path.posix.basename(file, path.posix.extname(file));
const code = (file: string) => isCodeSource(file) && !isTestSource(file);

function historyGroups(files: string[], commits: readonly ModuleMapCommit[]) {
  if (files.length < 2 || !commits.length) return [];
  const eligible = commits.filter(
    (commit) => commit.changedFiles <= MODULE_MAP_THRESHOLDS.maximumCommitFiles,
  );
  if (!eligible.length) return [];
  const facts = checkModuleMap({
    trackedFiles: files,
    nodes: files.map((file) => ({
      id: file,
      name: file,
      path: file,
      body: "",
      materials: [{ path: file, kind: "file" }],
    })),
    imports: [],
    commits: eligible,
  });
  const edges = new Map(files.map((file) => [file, new Set<string>()]));
  for (const part of facts.partFacts)
    for (const change of part.coChanges) {
      edges.get(part.id)!.add(change.partId);
      edges.get(change.partId)!.add(part.id);
    }
  const pending = new Set(files),
    groups: string[][] = [];
  while (pending.size) {
    const members: string[] = [],
      queue = [pending.values().next().value!];
    while (queue.length) {
      const file = queue.pop()!;
      if (!pending.delete(file)) continue;
      members.push(file);
      queue.push(...edges.get(file)!);
    }
    if (members.length > 1) groups.push(ordered(members));
  }
  return groups;
}

export function draftTextFileGroups(files: string[], commits: readonly ModuleMapCommit[]) {
  const prefixes = new Map<string, string[]>();
  for (const file of files) {
    const prefix = /^([^_.-]+[-_])/.exec(path.posix.basename(file))?.[1];
    if (prefix) prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), file]);
  }
  const groups = [...prefixes]
    .filter(([, members]) => members.length > 1)
    .map(([name, files]) => ({ name: name.slice(0, -1), files }));
  if (groups.length === 1 && groups[0]!.files.length === files.length) groups.length = 0;
  const grouped = new Set(groups.flatMap((group) => group.files));
  for (const members of historyGroups(
    files.filter((file) => !grouped.has(file)),
    commits,
  ))
    groups.push({ name: members.map(stem).join(" and "), files: members });
  // One group covering the directory offers no separating evidence.
  return groups.length === 1 && groups[0]!.files.length === files.length ? [] : groups;
}

/** Add real prose/asset layers while preserving every existing code grouping. */
export function draftTextDirectories(
  units: DraftUnit[],
  files: string[],
  textFiles: readonly string[],
  commits: readonly ModuleMapCommit[],
) {
  const projection = (values: DraftUnit[]) =>
    values.map((unit) => ({
      id: unit.key,
      path: unit.key,
      name: unit.key,
      body: "",
      materials: unit.materials,
    }));
  const before = checkModuleMap({
    trackedFiles: files,
    nodes: projection(units),
    imports: [],
    commits: [],
  });
  const owners = new Map(
    before.partFacts.flatMap((part) =>
      part.files.filter(code).map((file) => [file, part.id] as const),
    ),
  );
  const directoryUnits = new Map<string, DraftUnit>();
  for (const unit of units)
    for (const material of unit.materials)
      if (material.kind === "directory") directoryUnits.set(material.path, unit);
  const directories = new Set<string>();
  for (const file of files.filter((file) => !isCodeSource(file) && !isTestSource(file))) {
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  // Include every real intermediate layer leading to an evidenced code/product directory.
  for (const directory of [...directoryUnits.keys()]) {
    let parent = path.posix.dirname(directory);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  for (const directory of ordered(directories)) {
    if (directoryUnits.has(directory)) continue;
    const unit = {
      key: directory,
      ...(["docs", "doc"].includes(directory) ? { name: "Docs" } : {}),
      materials: [draftMaterial(directory + "/")],
    };
    units.push(unit);
    directoryUnits.set(directory, unit);
  }
  for (const [directory, unit] of directoryUnits) {
    if (unit.parentKey || unit.key !== directory) continue;
    let parent = path.posix.dirname(directory);
    while (parent !== ".") {
      const ancestor = directoryUnits.get(parent);
      if (ancestor && ancestor !== unit) {
        unit.parentKey = ancestor.key;
        break;
      }
      parent = path.posix.dirname(parent);
    }
  }
  const readable = new Set(textFiles);
  for (const [directory, parent] of directoryUnits) {
    const direct = files.filter(
      (file) => path.posix.dirname(file) === directory && readable.has(file) && !isCodeSource(file),
    );
    if (direct.length <= DRAFT_CODE_FILES) continue;
    for (const group of draftTextFileGroups(direct, commits))
      units.push({
        key: group.files[0]!,
        name: group.name,
        parentKey: parent.key,
        materials: group.files.map((file) => ({ path: file, kind: "file" })),
      });
  }
  const after = checkModuleMap({
    trackedFiles: files,
    nodes: projection(units),
    imports: [],
    commits: [],
  });
  const current = new Map(
    after.partFacts.flatMap((part) => part.files.map((file) => [file, part.id] as const)),
  );
  for (const [file, owner] of owners)
    if (current.get(file) !== owner)
      units.find((unit) => unit.key === owner)!.materials.push({ path: file, kind: "file" });
  return units;
}
