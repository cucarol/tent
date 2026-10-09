#!/usr/bin/env node
// One-off retained Node record conversion; no legacy reader is added to Tent.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { createHash } from "node:crypto";

const { nodeBasisRecordSchema } = await tsImport(
  "../../src/core/node-basis-record.ts",
  import.meta.url,
);
const { parseFrontmatter } = await tsImport("../../src/core/frontmatter.ts", import.meta.url);
const { isNodeId } = await tsImport("../../src/core/id.ts", import.meta.url);
const { nodeMaterialFingerprint } = await tsImport(
  "../../src/core/node-sync-record.ts",
  import.meta.url,
);
const { historicalNodeCatalog } = await tsImport(
  "../../src/core/node-semantic-history.ts",
  import.meta.url,
);
const { materialContent } = await tsImport("../../src/core/material-section.ts", import.meta.url);
const { isOperationalPath, nodeNotePath } = await tsImport(
  "../../src/core/paths.ts",
  import.meta.url,
);
const prefix = "Tent-Node-Record: ";
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
);
function git(root, args, input, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    input,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...gitEnv, GIT_OPTIONAL_LOCKS: "0" },
  });
}

// Only retained bytes at the declaration's commit can prove a missing algorithm.
// Never consult the working tree, current HEAD materials or the network.
function retainedMaterials(root) {
  const snapshots = new Map();
  return (commit, identity) => {
    let snapshot = snapshots.get(commit);
    if (!snapshot) {
      const entries = git(root, ["ls-tree", "-rz", commit])
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const [mode, type, blob] = line.slice(0, tab).split(" ");
          return { mode, type, blob, file: line.slice(tab + 1) };
        })
        .filter((entry) => entry.type === "blob" && /^100/.test(entry.mode));
      const bytes = git(
        root,
        ["cat-file", "--batch"],
        entries.map((entry) => entry.blob).join("\n") + "\n",
        null,
      );
      const files = new Map(),
        documents = new Map();
      let offset = 0;
      for (const entry of entries) {
        const end = bytes.indexOf(10, offset);
        const size = Number(bytes.subarray(offset, end).toString().split(" ")[2]);
        const raw = bytes.subarray(end + 1, end + 1 + size).toString("utf8");
        offset = end + 1 + size + 1;
        files.set(entry.file, raw);
        if (
          isOperationalPath(entry.file) ||
          entry.file !== nodeNotePath(path.posix.dirname(entry.file))
        )
          continue;
        const id = parseFrontmatter(raw).data.id;
        if (isNodeId(id)) {
          if (documents.has(id)) throw new Error(`Duplicate retained Node: ${id}`);
          documents.set(id, { path: path.posix.dirname(entry.file), raw });
        }
      }
      snapshot = { files, documents, nodes: historicalNodeCatalog(documents) };
      snapshots.set(commit, snapshot);
    }
    const node = /^node:(node-[^#?]+)(.*)$/.exec(identity);
    let target,
      suffix,
      isNode = false;
    if (node) {
      const document = snapshot.documents.get(node[1]);
      if (!document) throw new Error("Material Node is not retained at the record commit");
      target = nodeNotePath(document.path);
      suffix = node[2];
      isNode = true;
    } else {
      const address = JSON.parse(identity);
      if (
        !Array.isArray(address) ||
        address.length !== 3 ||
        address[0] !== "path" ||
        typeof address[1] !== "string" ||
        typeof address[2] !== "string"
      )
        throw new Error("Material identity has no retained local bytes");
      [, target, suffix] = address;
      isNode = [...snapshot.documents.values()].some(
        (document) => nodeNotePath(document.path) === target,
      );
    }
    const raw = snapshot.files.get(target);
    if (raw === undefined) throw new Error("Material file is not retained at the record commit");
    const locator = { kind: "path", anchor: "bundle", target, suffix };
    const version = isNode
      ? nodeMaterialFingerprint(raw, locator, snapshot.nodes)
      : createHash("sha256")
          .update(materialContent(raw, locator).replace(/\r\n?/g, "\n"))
          .digest("hex");
    return { version, path: target };
  };
}

function resolveMissingAlgorithms(record, id, commit, read, decisions) {
  const result = structuredClone(record);
  const groups = [
    ["materials", result.materials ?? []],
    ...(result.goals ?? []).map((goal, index) => [
      `goals[${index}].materials`,
      goal.materials ?? [],
    ]),
  ];
  for (const [field, materials] of groups)
    for (const [index, material] of materials.entries()) {
      if (
        typeof material.version !== "string" ||
        !/^[a-f0-9]{64}$/.test(material.version) ||
        material.fingerprintVersion !== undefined
      )
        continue;
      const decision = {
        id,
        commit,
        field: `${field}[${index}]`,
        identity: material.identity,
        recordedVersion: material.version,
      };
      try {
        const observed = read(commit, material.identity);
        decision.materialPath = observed.path;
        decision.recomputedVersion = observed.version;
        if (observed.version === material.version) {
          material.fingerprintVersion = 2;
          decision.action = "proved-v2";
        } else {
          decision.action = "removed-version";
          decision.reason = "Retained v2 fingerprint differs from recorded version";
        }
      } catch (error) {
        decision.action = "removed-version";
        decision.reason = error.message;
      }
      if (decision.action === "removed-version") delete material.version;
      decisions.push(decision);
    }
  return result;
}

// Match the writer's portability check, including JSON-encoded material identities.
function localPath(value) {
  if (typeof value === "string") {
    if (/^(?:[\\/]|file:)|(?:^|[^a-z0-9])[a-z]:[\\/]|\\\\[?.]\\/i.test(value)) return true;
    try {
      return localPath(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(localPath);
  return (
    value &&
    typeof value === "object" &&
    Object.entries(value).some(([key, item]) => localPath(key) || localPath(item))
  );
}

export function convertRecord(record, workspace) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Record must be an object");
  if (record.v !== undefined && record.v !== 1)
    throw new Error(`Unsupported record version: ${record.v}`);
  const result = structuredClone(record);
  if (result.v === undefined) {
    result.v = 1;
    for (const material of [
      ...(result.materials ?? []),
      ...(result.goals ?? []).flatMap((goal) => goal.materials ?? []),
    ]) {
      const repository = material.repository;
      if (!repository || typeof repository.commonDir !== "string") continue;
      const absolute = repository.commonDir;
      const windows = path.win32.isAbsolute(absolute) && /^(?:[a-z]:[\\/]|\\\\)/i.test(absolute);
      if (!windows && !path.isAbsolute(absolute)) continue;
      const paths = windows ? path.win32 : path;
      const relative = paths.relative(workspace, absolute).replaceAll("\\", "/") || ".";
      if (paths.isAbsolute(relative))
        throw new Error("repository.commonDir cannot be made relative to this workspace");
      repository.commonDir = relative;
    }
  }
  nodeBasisRecordSchema.parse(result);
  if (localPath(result)) throw new Error("Record still contains a local machine path");
  return result;
}

function assertStopped(root) {
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim())
    throw new Error("Capture all .tent changes and stop writers before conversion");
  const pending = fs
    .readdirSync(root)
    .filter((name) =>
      /^(?:mutation\.lock(?:\.guard|\.guard\.pending-[^/]+)?|node-move\.pending\.json|delete\.pending\.json)$/.test(
        name,
      ),
    );
  if (pending.length) throw new Error(`Workspace has pending operations: ${pending.join(", ")}`);
}

export function convertWorkspace(workspacePath, { dryRun = false } = {}) {
  const workspace = fs.realpathSync(workspacePath),
    root = path.join(workspace, ".tent");
  if (!fs.statSync(path.join(root, ".git")).isDirectory())
    throw new Error("Expected an independent .tent/.git directory");
  if (fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== fs.realpathSync(root))
    throw new Error("Not the .tent repository");
  assertStopped(root);
  const head = git(root, ["rev-parse", "HEAD"]).trim(),
    tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const live = new Map();
  for (const file of git(root, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    if (isOperationalPath(file) || file !== nodeNotePath(path.posix.dirname(file))) continue;
    const id = parseFrontmatter(fs.readFileSync(path.join(root, file), "utf8")).data.id;
    if (!isNodeId(id)) continue;
    if (live.has(id)) throw new Error(`Duplicate live Node: ${id}`);
    live.set(id, file);
  }
  const latest = new Map();
  const history = git(root, ["log", "--first-parent", "--format=%H%x00%B%x00", head]).split("\0");
  for (let index = 0; index + 1 < history.length; index += 2) {
    const commit = history[index].trim(),
      message = history[index + 1];
    for (const line of message.split("\n").reverse()) {
      if (!line.startsWith(prefix)) continue;
      const payload = line.slice(prefix.length);
      let pair, id;
      try {
        pair = JSON.parse(payload);
        id = Array.isArray(pair) ? pair[0] : undefined;
      } catch {
        const match = /^\s*\[\s*("(?:\\.|[^"\\])*")/.exec(payload);
        if (match) id = JSON.parse(match[1]);
      }
      if (live.has(id) && !latest.has(id))
        latest.set(id, {
          commit,
          record: Array.isArray(pair) && pair.length === 2 ? pair[1] : null,
        });
    }
  }
  const report = {
    workspace,
    dryRun,
    head,
    tree,
    liveNodes: live.size,
    converted: [],
    skippedV1: [],
    missing: [],
    failed: [],
    materialDecisions: [],
    commit: null,
  };
  const records = [];
  const readMaterial = retainedMaterials(root);
  for (const [id, file] of [...live].sort(([a], [b]) => a.localeCompare(b))) {
    if (!latest.has(id)) {
      report.missing.push(id);
      continue;
    }
    const { record: original, commit } = latest.get(id);
    try {
      const record = convertRecord(
        original?.v === undefined && original
          ? resolveMissingAlgorithms(original, id, commit, readMaterial, report.materialDecisions)
          : original,
        workspace,
      );
      if (original.v === 1) report.skippedV1.push(id);
      else {
        records.push([id, record]);
        report.converted.push(id);
      }
    } catch (error) {
      report.failed.push({ id, path: file, reason: error.message });
    }
  }
  if (report.failed.length || dryRun || !records.length) return report;
  assertStopped(root);
  if (git(root, ["rev-parse", "HEAD"]).trim() !== head)
    throw new Error("Workspace HEAD changed while planning");
  const message =
    "Tent: node.records-convert\n\nTent-Operation: node.records-convert\n" +
    records.map((pair) => prefix + JSON.stringify(pair)).join("\n") +
    "\n";
  const commit = git(
    root,
    ["-c", "user.name=Tent", "-c", "user.email=tent@localhost", "commit-tree", tree, "-p", head],
    message,
  ).trim();
  git(root, ["update-ref", "-m", "Tent: node.records-convert", "HEAD", commit, head]);
  report.commit = commit;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let reportPath;
  try {
    const args = process.argv.slice(2),
      workspace = args.shift();
    let dryRun = false;
    if (!workspace || workspace.startsWith("--"))
      throw new Error(
        "Usage: node scripts/one-off/convert-node-records.mjs <workspace> [--dry-run] [--report <file>]",
      );
    while (args.length) {
      const option = args.shift();
      if (option === "--dry-run") dryRun = true;
      else if (option === "--report" && args[0] && !args[0].startsWith("--"))
        reportPath = path.resolve(args.shift());
      else throw new Error(`Unknown or incomplete option: ${option}`);
    }
    if (reportPath) {
      const relative = path.relative(path.join(fs.realpathSync(workspace), ".tent"), reportPath);
      if (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
        throw new Error("Write the report outside .tent");
    }
    const report = convertWorkspace(workspace, { dryRun });
    const text = JSON.stringify(report, null, 2) + "\n";
    if (reportPath) fs.writeFileSync(reportPath, text);
    process.stdout.write(text);
    if (report.failed.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
